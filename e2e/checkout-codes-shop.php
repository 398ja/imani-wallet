<?php
/**
 * The shop's side of checkout-codes-staging.e2e.mts (#402): the REAL imani-coupon-core
 * (feat/redeemer) against staging, as a WooCommerce shop runs it (imani-checkout-woo CoreSettler).
 *
 * One JSON request on stdin, one JSON answer on stdout:
 *   {"op":"lookup|hold|release|redeem|cancel_feed|cancel|raw", "shop_sk", "code", "order_ref",
 *    "store", "gateway", "stall", "order_total", "currency"}
 * Gift wraps for the stall are RETURNED (RecordingRelay), and the harness publishes them.
 *
 *   docker run --rm --network host -v $CORE:/core -v $PWD/e2e:/e2e php:8.5-cli php /e2e/checkout-codes-shop.php
 */

declare(strict_types=1);

// PHP 8.5 deprecates curl_close() (CurlTransport calls it): notices go to stderr, never into the JSON.
ini_set( 'display_errors', 'stderr' );

require '/core/vendor/autoload.php';

use Imani\CouponCore\Cashu\MintClient;
use Imani\CouponCore\Checkout\CheckoutValidation;
use Imani\CouponCore\Code;
use Imani\CouponCore\Gateway\GatewayClient;
use Imani\CouponCore\Key\ShopKey;
use Imani\CouponCore\Nip98;
use Imani\CouponCore\Redeem\Redeemer;
use Imani\CouponCore\Redeem\StallHandoff;
use Imani\CouponCore\Store\CodeStoreClient;
use Imani\CouponCore\Store\CurlTransport;
use Imani\CouponCore\Store\HttpRequest;
use Imani\CouponCore\Store\RedeemedParts;
use Imani\CouponCore\Testing\RecordingRelay;

$in = json_decode( (string) stream_get_contents( STDIN ), true, 512, JSON_THROW_ON_ERROR );
$out = array();
try {
	$key   = ShopKey::fromSecretHex( $in['shop_sk'] );
	$http  = new CurlTransport( 30 );
	$store = new CodeStoreClient( $in['store'], $key, $http, 0 );
	$code  = isset( $in['code'] ) ? Code::parse( $in['code'] ) : null;
	$res   = static fn( $r ) => array( 'outcome' => $r->outcome->value, 'refusal' => $r->refusal, 'http' => $r->httpStatus );
	$redeemer = static fn() => new Redeemer( $key, static fn( string $url ) => new MintClient( $url, $http ), new GatewayClient( $in['gateway'], $key, $http ) );

	switch ( $in['op'] ) {
		case 'raw':
			// A byte-exact answer for the R2 comparison.
			$url  = rtrim( $in['store'], '/' ) . $in['path'];
			$body = $in['body'] ?? null;
			$r    = $http->send( new HttpRequest( $in['method'], $url, array( 'Authorization' => Nip98::authorization( $key, $in['method'], $url, $body ), 'Content-Type' => 'application/json' ), $body ) );
			$out  = array( 'http' => $r->status, 'body' => $r->body );
			break;
		case 'lookup':
			$r   = $store->lookup( $code );
			$out = $res( $r );
			if ( $r->ok() ) {
				$i = $r->value;
				$out['info'] = array( 'status' => $i->status, 'amount' => $i->amount, 'unit' => $i->unit, 'expires_at' => $i->expiresAt, 'stall_pubkey' => $i->stallPubkey, 'held_by' => $i->heldBy, 'parts' => count( $i->parts ) );
				$d = ( new CheckoutValidation( $in['currency'], $in['stall'] ) )->decide( $r, time(), (int) $in['order_total'], $in['order_ref'] ?? null );
				$out['decision'] = array( 'apply' => $d->apply, 'deduction' => $d->deduction, 'reason' => $d->reason, 'to_stall' => $d->plan?->toStall, 'split' => $d->plan?->split, 'to_customer' => $d->plan?->toCustomer );
			}
			break;
		case 'hold':
			$out = $res( $store->hold( $code, $in['order_ref'] ) );
			break;
		case 'release':
			$out = $res( $store->release( $code, $in['order_ref'] ) );
			break;
		case 'redeem':
			$lookup = $store->lookup( $code );
			$d      = ( new CheckoutValidation( $in['currency'], $in['stall'] ) )->decide( $lookup, time(), (int) $in['order_total'], $in['order_ref'] );
			if ( ! $d->apply ) {
				$out = array( 'stage' => 'decide', 'reason' => $d->reason );
				break;
			}
			$r = $store->redeem( $code, $in['order_ref'] );
			$out = array( 'redeem' => $res( $r ) );
			if ( ! $r->ok() ) {
				break;
			}
			$relay  = new RecordingRelay();
			$result = $redeemer()->redeem( $r->value, $d->plan, $in['stall'] );
			$hand   = new StallHandoff( $key, $relay, $store );
			$hand->toStall( $result, $in['stall'] );
			$change = $hand->changeToStore( $code, $result );
			$out += array(
				'customer_pubkey' => $r->value->customerPubkey,
				'redeemed_total'  => $r->value->total(),
				'deduction'       => $d->deduction,
				'stall_tokens'    => $result->stallTokens,
				'customer_tokens' => $result->customerTokens,
				'change'          => null === $change ? null : $res( $change ),
				'wraps'           => $relay->events,
			);
			break;
		case 'cancel_feed':
			$r   = $store->cancelling( 50 );
			$out = $res( $r ) + array( 'codes' => $r->ok() ? array_map( static fn( Code $c ) => $c->compact(), $r->value ) : array() );
			break;
		case 'cancel':
			$r   = $store->returnParts( $code );
			$out = array( 'return' => $res( $r ) );
			if ( ! $r->ok() ) {
				break;
			}
			$result = $redeemer()->cancel( $r->value, $in['stall'] );
			$sent   = ( new StallHandoff( $key, new RecordingRelay(), $store ) )->cancelledToStore( $code, $result );
			$out += array( 'customer_tokens' => $result->customerTokens, 'cancelled' => $res( $sent ), 'returned_total' => $r->value->total() );
			break;
		default:
			throw new InvalidArgumentException( 'unknown op' );
	}
} catch ( Throwable $e ) {
	$out['error'] = get_class( $e ) . ': ' . $e->getMessage();
}
echo json_encode( $out, JSON_UNESCAPED_SLASHES );

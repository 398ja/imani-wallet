import { useNavigate } from 'react-router-dom'
import { QrCode, Send } from 'lucide-react'

import { Button, Screen } from '../components/ui'

/**
 * Home, for a merchant: the till.
 *
 * Two buttons and nothing else. It used to open on the balance panel, three
 * recent movements and anything expiring — which is a fair summary of the
 * business and exactly the wrong thing to have on screen while a customer is
 * standing in front of you. A till is held facing outward: whoever is being
 * served can read what the merchant is holding, what they owe, and what they
 * last took in, from across the counter. All of it moved to the Dashboard,
 * which is a menu tap away and opened on purpose.
 *
 * Centred rather than top-aligned for the same reason a card reader is: the two
 * things you press all day should be under the thumb, not under the header.
 *
 * Nothing here reads the wallet any more, so there is no `onWalletChanged`
 * subscription either — the screens that show money keep their own.
 */
export function MerchantHomePage() {
  const navigate = useNavigate()

  return (
    <Screen>
      {/* Minus the header and the page padding, so the buttons sit on the
          middle of what is actually visible. svh, not vh: on a phone browser
          vh is the chrome-less height and the pair would sit low. */}
      <div className="flex min-h-[calc(100svh-9rem)] flex-col justify-center">
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={() => navigate('/sell')}>
            <Send className="mr-2 h-5 w-5" /> Sell
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate('/redeem')}>
            <QrCode className="mr-2 h-5 w-5" /> Redeem
          </Button>
        </div>
      </div>
    </Screen>
  )
}

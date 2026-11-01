-- Local bottin seed: the NIP-05 domain every local handle lives under (@name@imani.local).
--
-- A fresh bottin has no domains, so gateway-core's registration of a new handle answers
-- 404 "Domain not found: imani.local" and the wallet's Register fails with a 500 on
-- /api/v1/nip05. The old local stack only worked because this row was added by hand in
-- August and survived in its bottin-db volume. Idempotent: safe on every `up`.
--
-- verified = true: there is no DNS to verify against locally. BOTTIN_DEFAULT_DOMAIN in
-- imani-deploy/.env.test must match the name below.
INSERT INTO domains (name, verified, verification_method, verified_at, created_at, updated_at)
SELECT 'imani.local', true, 'DNS_TXT', now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM domains WHERE name = 'imani.local');

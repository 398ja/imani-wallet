# Security Deployment Guide

This document outlines security configurations required for deploying Imani Wallet in production.

## Content Security Policy (CSP) Headers

### Overview

Content Security Policy (CSP) is a critical security layer that helps prevent:
- Cross-Site Scripting (XSS) attacks
- Data injection attacks
- Clickjacking
- Other code injection vulnerabilities

### Recommended CSP Configuration

#### Option 1: HTTP Headers (Recommended)

Configure your web server to send CSP headers with all responses.

**Nginx Example:**

```nginx
# /etc/nginx/sites-available/imani-wallet

server {
    listen 443 ssl http2;
    server_name wallet.example.com;

    # SSL Configuration
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security Headers
    add_header Content-Security-Policy "default-src 'self'; \
        script-src 'self' 'wasm-unsafe-eval'; \
        style-src 'self' 'unsafe-inline'; \
        img-src 'self' data: https:; \
        font-src 'self' data:; \
        connect-src 'self' https://testnut.cashu.space wss://*.nostr.band wss://*.nostr.info; \
        frame-ancestors 'none'; \
        base-uri 'self'; \
        form-action 'self';" always;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    # HSTS (HTTP Strict Transport Security)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Static file serving
    root /var/www/imani-wallet;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache busting for static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

**Apache Example:**

```apache
# /etc/apache2/sites-available/imani-wallet.conf

<VirtualHost *:443>
    ServerName wallet.example.com
    DocumentRoot /var/www/imani-wallet

    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem
    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
    SSLCipherSuite HIGH:!aNULL:!MD5

    # Security Headers
    Header always set Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://testnut.cashu.space wss://*.nostr.band wss://*.nostr.info; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
    Header always set X-Frame-Options "DENY"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-XSS-Protection "1; mode=block"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header always set Permissions-Policy "geolocation=(), microphone=(), camera=()"
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"

    <Directory /var/www/imani-wallet>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted

        # SPA routing
        RewriteEngine On
        RewriteBase /
        RewriteRule ^index\.html$ - [L]
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule . /index.html [L]
    </Directory>

    # Cache busting
    <FilesMatch "\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</VirtualHost>
```

#### Option 2: Meta Tag (Fallback)

If you cannot configure HTTP headers, add a meta tag to your HTML (less secure):

```html
<!-- imani-web/src/jsMain/resources/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://testnut.cashu.space wss://*.nostr.band wss://*.nostr.info; frame-ancestors 'none'; base-uri 'self'; form-action 'self';">
    <title>Imani Wallet</title>
</head>
<body>
    <!-- ... -->
</body>
</html>
```

### CSP Directives Explained

| Directive | Value | Explanation |
|-----------|-------|-------------|
| `default-src` | `'self'` | Allow resources only from same origin |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Allow scripts from same origin + WASM evaluation |
| `style-src` | `'self' 'unsafe-inline'` | Allow styles from same origin + inline styles (Compose requires this) |
| `img-src` | `'self' data: https:` | Allow images from same origin, data URLs, and HTTPS |
| `font-src` | `'self' data:` | Allow fonts from same origin and data URLs |
| `connect-src` | `'self' https://testnut.cashu.space wss://*.nostr.band wss://*.nostr.info` | Allow connections to same origin, mint, and Nostr relays |
| `frame-ancestors` | `'none'` | Prevent embedding in iframes (clickjacking protection) |
| `base-uri` | `'self'` | Restrict `<base>` tag to same origin |
| `form-action` | `'self'` | Restrict form submissions to same origin |

### Production Hardening

For production deployments, update `connect-src` to include only your production mint and relay URLs:

```
connect-src 'self' https://your-production-mint.com wss://relay1.example.com wss://relay2.example.com;
```

### Testing CSP Configuration

1. **Browser Developer Tools:**
   - Open browser console
   - Look for CSP violation warnings
   - Fix reported violations

2. **Online Validators:**
   - https://csp-evaluator.withgoogle.com/
   - https://cspvalidator.org/

3. **Report-Only Mode (Testing):**
   ```nginx
   # Use this during testing to report violations without blocking
   add_header Content-Security-Policy-Report-Only "...your policy..." always;
   ```

## Additional Security Headers

### X-Frame-Options
Prevents clickjacking by denying embedding in frames:
```
X-Frame-Options: DENY
```

### X-Content-Type-Options
Prevents MIME type sniffing:
```
X-Content-Type-Options: nosniff
```

### X-XSS-Protection
Enables browser XSS filter:
```
X-XSS-Protection: 1; mode=block
```

### Referrer-Policy
Controls referrer information:
```
Referrer-Policy: strict-origin-when-cross-origin
```

### Permissions-Policy
Disables unnecessary browser features:
```
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

### Strict-Transport-Security (HSTS)
Forces HTTPS connections:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

## SSL/TLS Configuration

### Certificate Requirements
- Use valid SSL/TLS certificates (Let's Encrypt recommended)
- Enable TLS 1.2 and TLS 1.3 only
- Disable SSLv3, TLS 1.0, TLS 1.1

### Let's Encrypt Setup
```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d wallet.example.com

# Auto-renewal
sudo certbot renew --dry-run
```

## Environment Variables

Configure these environment variables for production:

```bash
# Mint Configuration
IMANI_MINT_URL=https://your-production-mint.com

# Nostr Relay Configuration
IMANI_NOSTR_RELAYS=wss://relay1.example.com,wss://relay2.example.com

# Security
IMANI_ENABLE_SECURITY_HEADERS=true
IMANI_CSP_REPORT_URI=https://your-csp-report-endpoint.com/report
```

## Monitoring and Logging

### CSP Violation Reporting

Configure a `report-uri` or `report-to` directive to collect CSP violations:

```nginx
add_header Content-Security-Policy "...your policy...; report-uri https://your-csp-report-endpoint.com/report;" always;
```

### Log Monitoring
Monitor logs for:
- Failed authentication attempts
- CSP violations
- Unusual access patterns
- Error spikes

## Deployment Checklist

- [ ] HTTPS enabled with valid certificate
- [ ] CSP headers configured
- [ ] All security headers enabled
- [ ] HSTS enabled
- [ ] TLS 1.2+ only
- [ ] Production mint/relay URLs configured
- [ ] CSP policy tested
- [ ] Security headers verified
- [ ] Monitoring/logging enabled
- [ ] Regular security updates scheduled

## References

- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [Mozilla Observatory](https://observatory.mozilla.org/)
- [SecurityHeaders.com](https://securityheaders.com/)

## Support

For security-related questions or to report vulnerabilities, please contact:
- security@example.com

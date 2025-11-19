# Imani Wallet Deployment Guide

This guide covers deploying the Imani Wallet web application to production.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Deployment Platforms](#deployment-platforms)
- [Environment Variables](#environment-variables)
- [CI/CD Pipeline](#cicd-pipeline)
- [Custom Domain Setup](#custom-domain-setup)
- [Error Tracking](#error-tracking)
- [Analytics](#analytics)
- [Security Considerations](#security-considerations)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before deploying, ensure you have:

1. **GitHub Account**: Source code hosted on GitHub
2. **Vercel Account**: For hosting the web application
3. **Domain Name** (optional): For custom domain setup
4. **Sentry Account** (optional): For error tracking
5. **Plausible Account** (optional): For privacy-respecting analytics

## Deployment Platforms

### Vercel (Recommended)

Vercel is the recommended platform for deploying the Imani Wallet web application due to:

- Automatic deployments from GitHub
- Edge network for fast global delivery
- Built-in SSL/TLS certificates
- Preview deployments for pull requests
- Zero-config setup for static sites

#### Initial Setup

1. **Import Project to Vercel**:
   ```bash
   npm install -g vercel
   vercel login
   vercel
   ```

2. **Configure Build Settings**:
   - Build Command: `./gradlew :imani-web:jsBrowserDistribution`
   - Output Directory: `imani-web/build/dist/js/productionExecutable`
   - Install Command: (leave empty - uses Gradle)

3. **Set Environment Variables** (see below)

#### Manual Deployment

```bash
# Build production bundle
./gradlew :imani-web:jsBrowserDistribution

# Deploy to Vercel
cd imani-web/build/dist/js/productionExecutable
vercel --prod
```

### Alternative: Netlify

1. **Build Configuration** (netlify.toml):
   ```toml
   [build]
     command = "./gradlew :imani-web:jsBrowserDistribution"
     publish = "imani-web/build/dist/js/productionExecutable"

   [[headers]]
     for = "/*"
     [headers.values]
       Content-Security-Policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; ..."
       X-Frame-Options = "DENY"
       X-Content-Type-Options = "nosniff"
   ```

2. **Deploy**:
   ```bash
   npm install -g netlify-cli
   netlify deploy --prod
   ```

## Environment Variables

### Required Variables

#### Vercel Configuration

Set these secrets in Vercel dashboard or via CLI:

```bash
# Vercel API token (for CI/CD)
vercel env add VERCEL_TOKEN

# Project identifiers
vercel env add VERCEL_ORG_ID
vercel env add VERCEL_PROJECT_ID
```

### Optional Variables

#### Sentry (Error Tracking)

```bash
# Sentry DSN for error reporting
vercel env add SENTRY_DSN production

# For uploading source maps (CI only)
vercel env add SENTRY_AUTH_TOKEN production
vercel env add SENTRY_ORG production
vercel env add SENTRY_PROJECT production
```

#### Plausible (Analytics)

```bash
# Your domain name for analytics
vercel env add PLAUSIBLE_DOMAIN production
```

### GitHub Secrets

For CI/CD pipeline, add these secrets to GitHub repository:

1. Go to: `Settings > Secrets and variables > Actions`
2. Add the following secrets:

| Secret Name | Description |
|-------------|-------------|
| `VERCEL_TOKEN` | Vercel API token |
| `VERCEL_ORG_ID` | Vercel organization ID |
| `VERCEL_PROJECT_ID` | Vercel project ID |
| `SENTRY_DSN` | Sentry Data Source Name |
| `SENTRY_AUTH_TOKEN` | Sentry authentication token |
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project slug |

## CI/CD Pipeline

The project uses GitHub Actions for automated builds and deployments.

### Workflow Overview

Located at: `.github/workflows/deploy-web.yml`

**Triggers**:
- Push to `main` or `master` branch → Production deployment
- Pull requests → Preview deployment
- Manual trigger via GitHub Actions UI

**Jobs**:

1. **Build**: Compiles Kotlin/JS, runs tests, creates production bundle
2. **Deploy Preview**: Deploys to Vercel preview URL (PR only)
3. **Deploy Production**: Deploys to production domain (main/master only)
4. **Security Scan**: Runs dependency vulnerability checks

### Manual Workflow Trigger

```bash
# Via GitHub CLI
gh workflow run deploy-web.yml

# Or through GitHub UI:
# Actions > Deploy Web Application > Run workflow
```

## Custom Domain Setup

### Vercel Domain Configuration

1. **Add Domain**:
   ```bash
   vercel domains add wallet.imani.cash
   ```

2. **Configure DNS**:
   - Add CNAME record pointing to Vercel:
     ```
     wallet.imani.cash CNAME cname.vercel-dns.com
     ```

3. **SSL Certificate**:
   - Automatically provisioned by Vercel
   - Supports automatic renewal

### Subdomain Setup

For staging/testing environments:

```bash
vercel domains add staging.wallet.imani.cash
```

## Error Tracking

### Sentry Setup

1. **Create Sentry Project**:
   - Go to https://sentry.io
   - Create new project: JavaScript
   - Copy DSN

2. **Configure Environment**:
   ```bash
   vercel env add SENTRY_DSN production
   # Example: https://abc123@o123456.ingest.sentry.io/789
   ```

3. **Source Maps Upload**:
   - Automatically handled by CI/CD pipeline
   - Requires `SENTRY_AUTH_TOKEN` secret

4. **Error Capture**:
   - Automatic: Unhandled exceptions
   - Manual: `ErrorTracking.captureException(error, context)`

### Monitoring Errors

View errors at: https://sentry.io/organizations/YOUR_ORG/issues/

**Alert Configuration**:
- Set up alerts for critical errors
- Configure Slack/email notifications
- Define error rate thresholds

## Analytics

### Plausible Setup

Plausible provides privacy-respecting, cookie-free analytics.

1. **Create Plausible Account**:
   - Go to https://plausible.io
   - Add your domain

2. **Configure Domain**:
   ```bash
   vercel env add PLAUSIBLE_DOMAIN production
   # Example: wallet.imani.cash
   ```

3. **Custom Events**:
   ```kotlin
   // Track user actions
   Analytics.trackEvent("Voucher Created")
   Analytics.trackEvent("Settings Opened", mapOf(
       "section" to "security"
   ))
   ```

4. **Dashboard Access**:
   - View real-time analytics at https://plausible.io
   - No personal data collected
   - GDPR/CCPA compliant by default

### Alternative: Self-Hosted Analytics

For maximum privacy, self-host Plausible:

```bash
# Docker Compose
git clone https://github.com/plausible/hosting
cd hosting
docker-compose up -d
```

Update analytics configuration to point to your instance.

## Security Considerations

### Content Security Policy

Production CSP (in `vercel.json`):

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self' data:;
  connect-src 'self' https://testnut.cashu.space wss://*.nostr.band wss://*.nostr.info https://plausible.io;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
```

**Important**:
- Remove `'unsafe-inline'` from `script-src` in production if possible
- Only allow necessary external domains in `connect-src`
- Regularly review and update CSP rules

### Security Headers

Configured in `vercel.json`:

```json
{
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
}
```

### HTTPS Enforcement

- Automatic via Vercel/Netlify
- All HTTP requests redirect to HTTPS
- HSTS enabled by default

### Dependency Security

Automated scanning via GitHub Actions:

```bash
./gradlew dependencyCheckAnalyze
```

Review reports in CI artifacts.

## Monitoring

### Production Checks

1. **Health Check**:
   - Verify app loads: https://wallet.imani.cash
   - Check browser console for errors
   - Test core functionality

2. **Performance**:
   - Lighthouse score (target: >90)
   - Time to Interactive (target: <3s)
   - Bundle size (monitor trends)

3. **Error Rates**:
   - Sentry dashboard
   - Set alerts for >1% error rate

4. **Analytics**:
   - Daily active users
   - Feature usage
   - Browser/device distribution

### Uptime Monitoring

Recommended services:
- **UptimeRobot**: Free tier, 5-minute checks
- **Pingdom**: Advanced monitoring
- **StatusCake**: Multiple probe locations

## Troubleshooting

### Build Failures

**Symptom**: CI/CD build fails

**Check**:
```bash
# Local build test
./gradlew clean :imani-web:jsBrowserDistribution --stacktrace

# Check Gradle wrapper
./gradlew --version
```

**Common Issues**:
- Gradle version mismatch
- Missing dependencies
- Kotlin compiler errors

### Deployment Failures

**Symptom**: Vercel deployment fails

**Check**:
1. Vercel build logs
2. Output directory exists: `imani-web/build/dist/js/productionExecutable`
3. Environment variables set correctly

### Runtime Errors

**Symptom**: App crashes in production

**Debug**:
1. Check Sentry for stack traces
2. Review browser console (if accessible)
3. Check CSP violations
4. Verify external service connectivity (Cashu mint, Nostr relays)

### Performance Issues

**Symptom**: Slow page load

**Optimize**:
1. Check bundle size: `ls -lh imani-web/build/dist/js/productionExecutable/`
2. Enable code splitting (if needed)
3. Optimize images/assets
4. Review CDN cache settings

### CSP Violations

**Symptom**: Resources blocked by CSP

**Fix**:
1. Check browser console for violations
2. Update CSP in `vercel.json`
3. Test locally before deploying
4. Avoid inline scripts/styles

## Production Checklist

Before deploying to production:

- [ ] All tests passing: `./gradlew test`
- [ ] Production build successful: `./gradlew :imani-web:jsBrowserDistribution`
- [ ] Environment variables configured
- [ ] Custom domain configured (if applicable)
- [ ] SSL certificate active
- [ ] Sentry error tracking configured
- [ ] Analytics configured
- [ ] Security headers verified
- [ ] CSP policy reviewed
- [ ] Performance tested (Lighthouse)
- [ ] Backup plan documented
- [ ] Monitoring alerts configured

## Rollback Procedure

If deployment causes issues:

### Vercel Rollback

1. **Via Dashboard**:
   - Go to Vercel project
   - Deployments tab
   - Find last working deployment
   - Click "..." → "Promote to Production"

2. **Via CLI**:
   ```bash
   vercel rollback
   ```

### GitHub Revert

```bash
# Revert last commit
git revert HEAD
git push origin main

# CI/CD will auto-deploy previous version
```

## Support and Resources

- **Vercel Docs**: https://vercel.com/docs
- **Sentry Docs**: https://docs.sentry.io
- **Plausible Docs**: https://plausible.io/docs
- **GitHub Actions**: https://docs.github.com/actions
- **Project Issues**: https://github.com/YOUR_ORG/imani-wallet/issues

## Next Steps

After successful deployment:

1. Monitor error rates for first 24 hours
2. Review analytics to verify tracking
3. Test on multiple devices/browsers
4. Gather user feedback
5. Plan iterative improvements

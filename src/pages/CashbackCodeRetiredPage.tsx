import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { BackLink, Button, Notice, PageHeader, Screen } from '../components/ui'
import { replayPendingCashback } from '../lib/cashback'
import { CODES_RETIRED } from '../lib/cashlinkCopy'

/**
 * `/receive/cashback` after typed codes were retired (wallet#268 phase 1).
 *
 * The page where a customer typed a code is gone; this keeps the route for bookmarks and old
 * links during the transition, says what to do instead, and still banks any Cashlink that was
 * claimed but never added (the replay the old page ran on arrival). A later phase removes the
 * route.
 */
export function CashbackCodeRetiredPage() {
  const navigate = useNavigate()
  const [recovered, setRecovered] = useState(false)

  useEffect(() => {
    let live = true
    void replayPendingCashback().then((didRecover) => {
      if (live && didRecover) setRecovered(true)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <Screen>
      <BackLink to="/receive" label="Back" />
      <PageHeader title="Cashlink" />
      {/* Good news, so the success tone and a polite status, not the red
          assertive `Alert` it used to borrow: a voucher arriving read as an
          error at a glance. */}
      {recovered && <Notice tone="success">An earlier Cashlink finished arriving just now. Check your wallet.</Notice>}
      <p className="text-mono-700 dark:text-mono-200">{CODES_RETIRED}</p>
      {/* The page's only action, so it carries the primary weight. As a ghost
          button it read as a caption and left the screen without a clear exit. */}
      <Button size="lg" className="mt-6 w-full" onClick={() => navigate('/')}>
        Done
      </Button>
    </Screen>
  )
}

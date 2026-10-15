import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Alert, BackLink, Button, PageHeader, Screen } from '../components/ui'
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
      {recovered && <Alert>An earlier Cashlink finished arriving just now. Check your wallet.</Alert>}
      <p className="text-mono-700 dark:text-mono-200">{CODES_RETIRED}</p>
      <Button variant="ghost" className="mt-4 w-full" onClick={() => navigate('/')}>
        Done
      </Button>
    </Screen>
  )
}

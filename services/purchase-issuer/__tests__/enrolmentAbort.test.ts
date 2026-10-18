/**
 * @vitest-environment node
 *
 * Review of #302. The card-sales endpoints are public (the edge routes them). A client that sends
 * half a body and hangs up made `readBody` reject with "aborted", nothing caught it, and on
 * Node 20 an unhandled rejection ends the process: every stall's card purchases stopped minting
 * until a restart. Red on the PR head: /home/eric/IdeaProjects/.wt/rev302-abort-red.log
 */
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'

import { EnrolmentService } from '../enrolment'
import { ninetyDayTerm } from './stallFixture'
import { mountEnrolment, server } from '../server'

describe('a client that drops mid-body', () => {
  it('does not leave an unhandled rejection, and the server keeps answering', async () => {
    const unhandled: unknown[] = []
    const record = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', record)
    mountEnrolment(new EnrolmentService({ vault: {} as never, confirmer: {} as never, publicOrigin: 'https://x', validityFor: ninetyDayTerm }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('POST /api/v1/card-sales/enrolment HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc')
          setTimeout(() => {
            socket.destroy()
            resolve()
          }, 100)
        })
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(unhandled).toEqual([])
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)
    } finally {
      process.off('unhandledRejection', record)
      mountEnrolment(null)
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

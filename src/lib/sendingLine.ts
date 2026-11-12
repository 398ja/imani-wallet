import type { SendProgress } from './pay'

/**
 * What the send and pay screens say while money is moving (#552).
 *
 * "This takes a few seconds" was true of a send whose relay took the gift wrap first time, and
 * false of one the gateway is retrying: its DM retry runs every two minutes, and a bundle waits
 * for each part in turn. A customer told "seconds" who is still looking at the spinner after a
 * minute has every reason to think it is stuck and leave. So the line says which voucher is
 * going, and says plainly when the network is being slow and the gateway is trying again.
 */
export function sendingLine(progress: SendProgress | null): string {
  const of = progress && progress.parts > 1 ? ` Voucher ${progress.part} of ${progress.parts}.` : ''
  if (progress?.retrying) {
    return (
      `The network is slow, so this is taking longer than usual: it can take a few minutes.${of}` +
      ' Nothing is lost, and nothing is sent twice. Keep this screen open.'
    )
  }
  return `This takes a few seconds.${of} Do not close this screen.`
}

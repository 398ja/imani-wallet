/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ReauthDialog } from '../ReauthDialog'

/**
 * The dialog, driven as a user drives it.
 *
 * The bug this whole change exists for was not a wrong calculation — it was a
 * screen with no way off it. So what these assert is reachability: that the
 * prompt actually appears, that a correct passphrase is the fast path, that a
 * wrong one says so and lets you try again, and above all that someone who has
 * forgotten their passphrase is not stuck. The last of those is the one a unit
 * test of the controller could never catch.
 */
describe('ReauthDialog', () => {
  afterEach(cleanup)

  const noop = () => {}

  it('announces itself as a modal dialog, named by its own heading', () => {
    render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} />)

    const dialog = screen.getByRole('dialog')
    // `aria-modal` is what makes a screen reader treat the app behind it as
    // inert, matching what the scrim does visually.
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Session expired' })).toBeTruthy()
  })

  it('greets the user by name when the app knows it', () => {
    render(
      <ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} name="Ada" />,
    )

    expect(screen.getByText(/Welcome back, Ada/)).toBeTruthy()
  })

  it('focuses the passphrase field, so the first keystroke lands', () => {
    render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} />)

    // The dialog arrives unannounced over whatever the user was doing. Without
    // this they type into nothing.
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Passphrase'))
  })

  it('submits the typed passphrase', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ReauthDialog onSubmit={onSubmit} onLogout={noop} onRestore={noop} />)

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), {
      target: { value: 'correct horse' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('correct horse'))
  })

  it('submits on Enter — a one-field form should not need the mouse', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ReauthDialog onSubmit={onSubmit} onLogout={noop} onRestore={noop} />)

    const field = screen.getByPlaceholderText('Passphrase')
    fireEvent.change(field, { target: { value: 'correct horse' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('correct horse'))
  })

  it('refuses to submit an empty passphrase', () => {
    const onSubmit = vi.fn()
    render(<ReauthDialog onSubmit={onSubmit} onLogout={noop} onRestore={noop} />)

    const unlock = screen.getByRole('button', { name: 'Unlock' })
    expect(unlock).toHaveProperty('disabled', true)
    fireEvent.click(unlock)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the reason a failed attempt failed, and stays open for another', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('That passphrase is not right. Try again.'))
    render(<ReauthDialog onSubmit={onSubmit} onLogout={noop} onRestore={noop} />)

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    // The message is the app's, not WebCrypto's: a raw DOMException on a dialog
    // that appeared unannounced is how someone concludes their money is gone.
    await screen.findByText('That passphrase is not right. Try again.')
    // A failed attempt is not an exit.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps what was typed after a failure, so a typo is one backspace away', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('nope'))
    render(<ReauthDialog onSubmit={onSubmit} onLogout={noop} onRestore={noop} />)

    const field = screen.getByPlaceholderText('Passphrase') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'almost-right' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await screen.findByText('nope')
    expect(field.value).toBe('almost-right')
  })

  /**
   * The part that makes this a dialog rather than a trap. A passphrase prompt
   * is useless to the one person most likely to be looking at it — someone who
   * has forgotten theirs — so the other ways out have to be here and findable.
   */
  describe('the ways out', () => {
    it('hides the destructive options behind a disclosure, showing the common path first', () => {
      render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} />)

      // Not rendered at all until asked for: logging out erases the key and
      // every trace of the account from this browser, and a dialog that arrives
      // mid-task must not put that next to the button people mean to press.
      expect(screen.queryByRole('button', { name: /Log out/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
    })

    it('names the user\u2019s actual problem on the disclosure', () => {
      render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} />)

      // Someone who has forgotten their passphrase has to RECOGNISE their own
      // situation here, which a label naming the mechanism ("More options")
      // would not let them do.
      const toggle = screen.getByRole('button', {
        name: /Forgotten your passphrase, or using a different account\?/,
      })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('offers a restore route for a forgotten passphrase', () => {
      const onRestore = vi.fn()
      render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={onRestore} />)

      fireEvent.click(screen.getByRole('button', { name: /Forgotten your passphrase/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }))

      expect(onRestore).toHaveBeenCalled()
    })

    it('is honest that there is no passphrase reset', () => {
      render(<ReauthDialog onSubmit={async () => {}} onLogout={noop} onRestore={noop} />)

      fireEvent.click(screen.getByRole('button', { name: /Forgotten your passphrase/ }))

      // Saying so here is the difference between a user going to find their
      // backup and a user waiting for a reset email that is never coming.
      expect(screen.getByText(/no passphrase reset/)).toBeTruthy()
    })

    it('offers logout, labelled with what it actually does', () => {
      const onLogout = vi.fn()
      render(<ReauthDialog onSubmit={async () => {}} onLogout={onLogout} onRestore={noop} />)

      fireEvent.click(screen.getByRole('button', { name: /Forgotten your passphrase/ }))
      // "Log out" alone would understate it: this erases the key, and without a
      // backup the coupons it decrypts are unspendable.
      fireEvent.click(screen.getByRole('button', { name: 'Log out and erase this device' }))

      expect(onLogout).toHaveBeenCalled()
    })
  })
})

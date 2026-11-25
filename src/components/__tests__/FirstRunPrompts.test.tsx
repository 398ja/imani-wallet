/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../lib/notifications/manager', () => ({ enableNotifications: vi.fn(), readStatus: vi.fn() }))
vi.mock('../../lib/fleet/app', () => ({ fleetController: vi.fn() }))

const { FirstRunPrompts } = await import('../FirstRunPrompts')
const { firstRunAnswer, recordFirstRunAnswer } = await import('../../lib/firstRunPrompts')
import type { FirstRunPorts } from '../../lib/firstRunPrompts'

/**
 * The two first-run questions are asked once each, like "Confirm payments you receive?": either
 * answer is applied and kept, so the next visit does not ask again.
 */

const ME = 'a'.repeat(64)

function ports(over: Partial<FirstRunPorts> = {}): FirstRunPorts {
  return {
    notificationsAskable: vi.fn(async () => true),
    enableNotifications: vi.fn(async () => ({ ok: true, reason: null })),
    healthAskable: vi.fn(async () => true),
    enableHealth: vi.fn(async () => undefined),
    ...over,
  }
}

function show(io: FirstRunPorts, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FirstRunPrompts pubkey={ME} stall={false} ports={io} />
    </MemoryRouter>,
  )
}

const NOTIFY = { name: 'Turn on notifications?' }
const HEALTH = { name: 'Help improve Imani?' }

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe('the first-run questions', () => {
  it('asks about notifications first, on Home', async () => {
    // Arrange
    const io = ports()

    // Act
    show(io)

    // Assert
    expect(await screen.findByRole('heading', NOTIFY)).toBeTruthy()
    expect(screen.queryByRole('heading', HEALTH)).toBeNull()
  })

  it('Turn on enables notifications, keeps the yes, then asks about health checks', async () => {
    // Arrange
    const io = ports()
    show(io)
    await screen.findByRole('heading', NOTIFY)

    // Act
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Turn on' })))

    // Assert
    expect(io.enableNotifications).toHaveBeenCalledTimes(1)
    expect(firstRunAnswer('notifications', ME)).toBe(true)
    expect(await screen.findByRole('heading', HEALTH)).toBeTruthy()
  })

  it('Not now changes nothing, keeps the no, and moves on', async () => {
    // Arrange
    const io = ports()
    show(io)
    await screen.findByRole('heading', NOTIFY)

    // Act
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Not now' })))

    // Assert
    expect(io.enableNotifications).not.toHaveBeenCalled()
    expect(firstRunAnswer('notifications', ME)).toBe(false)
    expect(await screen.findByRole('heading', HEALTH)).toBeTruthy()
  })

  it('Turn on for health checks opts in, keeps the yes and shows nothing more', async () => {
    // Arrange
    recordFirstRunAnswer('notifications', ME, false)
    const io = ports()
    show(io)
    await screen.findByRole('heading', HEALTH)

    // Act
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Turn on' })))

    // Assert
    expect(io.enableHealth).toHaveBeenCalledTimes(1)
    expect(firstRunAnswer('health', ME)).toBe(true)
    expect(screen.queryByRole('heading', HEALTH)).toBeNull()
  })

  it('shows the health check consent text before the owner agrees', async () => {
    // Arrange
    recordFirstRunAnswer('notifications', ME, true)

    // Act
    show(ports())

    // Assert
    expect(await screen.findByText(/picked at random to send an anonymised health check/)).toBeTruthy()
    expect(screen.getByText(/Never your key, vouchers, codes/)).toBeTruthy()
  })

  it('does not ask again once both are answered, on the next visit', async () => {
    // Arrange
    recordFirstRunAnswer('notifications', ME, true)
    recordFirstRunAnswer('health', ME, false)
    const io = ports()

    // Act
    show(io)
    await act(async () => undefined)

    // Assert
    expect(screen.queryByRole('heading', NOTIFY)).toBeNull()
    expect(screen.queryByRole('heading', HEALTH)).toBeNull()
    expect(io.notificationsAskable).not.toHaveBeenCalled()
    expect(io.healthAskable).not.toHaveBeenCalled()
  })

  it('skips a question that could change nothing here, without recording an answer', async () => {
    // Arrange
    const io = ports({ notificationsAskable: async () => false, healthAskable: async () => false })

    // Act
    show(io)
    await act(async () => undefined)

    // Assert
    expect(screen.queryByRole('heading', NOTIFY)).toBeNull()
    expect(screen.queryByRole('heading', HEALTH)).toBeNull()
    expect(firstRunAnswer('notifications', ME)).toBeNull()
    expect(firstRunAnswer('health', ME)).toBeNull()
  })

  it('is not shown away from Home', async () => {
    // Arrange
    const io = ports()

    // Act
    show(io, '/send')
    await act(async () => undefined)

    // Assert
    expect(screen.queryByRole('heading', NOTIFY)).toBeNull()
  })

  it('says why when notifications could not be turned on, and still keeps the answer', async () => {
    // Arrange
    const io = ports({ enableNotifications: async () => ({ ok: false, reason: 'Notifications are blocked for Imani.' }) })
    show(io)
    await screen.findByRole('heading', NOTIFY)

    // Act
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Turn on' })))

    // Assert
    expect(screen.getByRole('heading', { name: 'Notifications are not on' })).toBeTruthy()
    expect(screen.getByText(/Notifications are blocked for Imani\. You can try again in Settings, Notifications\./)).toBeTruthy()
    expect(firstRunAnswer('notifications', ME)).toBe(true)
  })

  it('goes away when the question is answered in Settings instead', async () => {
    // Arrange
    show(ports({ healthAskable: async () => false }))
    await screen.findByRole('heading', NOTIFY)

    // Act
    await act(async () => recordFirstRunAnswer('notifications', ME, true))

    // Assert
    expect(screen.queryByRole('heading', NOTIFY)).toBeNull()
  })
})

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SkeletonLine } from '../Skeleton'

describe('SkeletonLine', () => {
  it('carries the typography class of the line it replaces', () => {
    const { container } = render(<SkeletonLine text="text-sm" width="w-32" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('text-sm')
    const bar = wrapper.firstElementChild as HTMLElement
    // Height in em, so it scales with whatever font size the wrapper resolves.
    expect(bar.className).toContain('h-[0.72em]')
    expect(bar.className).toContain('w-32')
    expect(bar.getAttribute('aria-hidden')).toBe('true')
  })
})

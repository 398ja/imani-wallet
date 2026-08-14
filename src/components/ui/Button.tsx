import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-xl font-medium transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none',
          {
            'bg-mono-900 text-mono-50 hover:bg-mono-800 dark:bg-mono-50 dark:text-mono-900 dark:hover:bg-mono-200':
              variant === 'primary',
            'bg-mono-100 text-mono-900 hover:bg-mono-200 dark:bg-mono-800 dark:text-mono-50 dark:hover:bg-mono-700':
              variant === 'secondary',
            'bg-transparent hover:bg-mono-100 dark:hover:bg-mono-800':
              variant === 'ghost',
            'border border-mono-200 bg-transparent hover:bg-mono-100 dark:border-mono-700 dark:hover:bg-mono-800':
              variant === 'outline',
            'px-3 py-2 text-sm': size === 'sm',
            'px-6 py-3 text-base': size === 'md',
            'px-8 py-4 text-lg': size === 'lg',
          },
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

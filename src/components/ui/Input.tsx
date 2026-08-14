import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, type = 'text', ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-mono-600 dark:text-mono-400 mb-2">
            {label}
          </label>
        )}
        <input
          type={type}
          ref={ref}
          className={cn(
            'w-full rounded-xl border border-mono-200 bg-white px-4 py-3',
            'text-mono-900 placeholder:text-mono-400',
            'focus:border-mono-400 focus:outline-none focus:ring-0',
            'dark:border-mono-700 dark:bg-mono-800 dark:text-mono-50 dark:placeholder:text-mono-500',
            'transition-colors duration-200',
            error && 'border-red-500 dark:border-red-500',
            className
          )}
          {...props}
        />
        {error && (
          <p className="mt-1.5 text-sm text-red-500">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

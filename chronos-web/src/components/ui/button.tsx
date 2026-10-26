import React from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      variant = 'secondary',
      size = 'md',
      loading = false,
      disabled,
      ...props
    },
    ref,
  ) => {
    const variantStyles = {
      primary:
        'bg-slate-100 text-slate-950 hover:bg-white active:bg-slate-200 font-semibold shadow-sm',
      secondary:
        'bg-slate-900/90 hover:bg-slate-800 text-slate-200 border border-slate-800/80 active:bg-slate-950',
      danger:
        'bg-rose-950/40 text-rose-300 hover:bg-rose-900/50 border border-rose-800/60 active:bg-rose-900',
      outline:
        'border border-slate-800 hover:bg-slate-900/60 text-slate-300 hover:text-white',
      ghost:
        'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200 border border-transparent',
    };

    const sizeStyles = {
      sm: 'px-2.5 py-1 text-xs rounded-md gap-1.5',
      md: 'px-3.5 py-1.5 text-sm rounded-lg gap-2',
      lg: 'px-5 py-2.5 text-base rounded-xl gap-2.5',
      icon: 'p-2 rounded-lg',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-medium transition-all duration-150 select-none disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {loading && (
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
        )}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';

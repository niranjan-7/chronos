import React from 'react';
import { cn } from '../../lib/utils';

export type BadgeVariant =
  | 'healthy'
  | 'warning'
  | 'breach'
  | 'rose'
  | 'paused'
  | 'cyan'
  | 'neutral'
  | 'outline'
  | 'urgent'
  | 'high'
  | 'medium'
  | 'low';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  pulse?: boolean;
}

export function Badge({
  children,
  className,
  variant = 'neutral',
  pulse = false,
  ...props
}: BadgeProps) {
  const variantStyles: Record<BadgeVariant, string> = {
    healthy: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    breach: 'bg-rose-500/15 text-rose-400 border-rose-500/35 shadow-[0_0_12px_rgba(244,63,94,0.25)]',
    rose: 'bg-rose-500/15 text-rose-400 border-rose-500/35',
    paused: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/25',
    cyan: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/25',
    neutral: 'bg-slate-800/80 text-slate-300 border-slate-700/60',
    outline: 'bg-slate-900 text-slate-300 border-slate-700/60',
    urgent: 'bg-rose-600/15 text-rose-400 border-rose-500/30',
    high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    low: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-medium border transition-colors',
        variantStyles[variant],
        (pulse || variant === 'breach') && 'animate-pulse',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

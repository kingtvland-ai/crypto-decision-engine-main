import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from './ui/button';
import { ThemeToggle } from './ThemeToggle';
import {
  BarChart3,
  Bell,
  Briefcase,
  Bot,
  TrendingUp,
  Menu,
  X,
  Shield,
  Activity,
  CandlestickChart
} from 'lucide-react';

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

// One icon set, one colour. The previous version gave each link its own hue
// (green/purple/red/blue/cyan/orange/yellow), which read as decoration and
// left no colour free to mark the ACTIVE page — the thing a nav actually has
// to communicate. Red in particular collided with "loss".
const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: BarChart3, label: 'בית' },
  { to: '/simulation-bot', icon: Bot, label: 'בוט סימולציה' },
  { to: '/real-trading', icon: Shield, label: 'בוט מסחר אמיתי' },
  { to: '/portfolio', icon: Briefcase, label: 'תיק השקעות' },
  { to: '/advanced-analysis', icon: TrendingUp, label: 'ניתוח מתקדם' },
  { to: '/backtest-results', icon: Activity, label: 'Backtest' },
  { to: '/alerts', icon: Bell, label: 'התראות והגדרות' },
];

const Navigation = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { pathname } = useLocation();

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <nav className="glass sticky top-0 z-50 border-x-0 border-t-0">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="pt-1 text-right">
          <span className="text-[11px] text-muted-foreground">בס״ד</span>
        </div>

        <div className="flex h-16 items-center justify-between gap-4">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2.5 rounded-lg"
            aria-label="בוט מסחר של מנחם — דף הבית"
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/20"
              aria-hidden="true"
            >
              <CandlestickChart className="h-5 w-5 text-primary-foreground" />
            </span>
            <span className="hidden font-display text-lg font-bold text-foreground sm:block">
              בוט מסחר של מנחם
            </span>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium',
                    'transition-colors duration-200 cursor-pointer',
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  ].join(' ')}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">{item.label}</span>
                </Link>
              );
            })}
            <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />
            <ThemeToggle />
          </div>

          <div className="flex items-center gap-1 md:hidden">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMobileMenuOpen((open) => !open)}
              aria-label={isMobileMenuOpen ? 'סגור תפריט' : 'פתח תפריט'}
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-nav"
              className="h-11 w-11 cursor-pointer"
            >
              {isMobileMenuOpen
                ? <X className="h-5 w-5" aria-hidden="true" />
                : <Menu className="h-5 w-5" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        {/* `hidden` rather than unmounting: the toggle's aria-controls needs a
            target that exists, and the panel keeps its scroll position. */}
        <div id="mobile-nav" hidden={!isMobileMenuOpen} className="border-t border-border md:hidden">
          <div className="space-y-1 py-2">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setIsMobileMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    // min-h-11 = 44px touch target
                    'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium',
                    'transition-colors duration-200 cursor-pointer',
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  ].join(' ')}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navigation;

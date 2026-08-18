import { SlidersHorizontal } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover';
import { Button } from '@/client/components/ui/button';
import { Switch } from '@/client/components/ui/switch';
import {
  LEVEL_META,
  OVERRIDE_META,
  matchLevel,
  presetToOverrides,
  type AssistanceLevel,
  type AssistanceOverrides,
  type AssistanceSettings,
} from '@/client/lib/assistance';
import { cn } from '@/lib/utils';

const LEVELS: AssistanceLevel[] = [1, 2, 3, 4];

export function EditorSettings({
  settings,
  onChange,
  size = 'sm',
  planGate,
  onPlanGateChange,
  iconOnly = false,
}: {
  settings: AssistanceSettings;
  onChange: (next: AssistanceSettings) => void;
  /** Trigger size — phones pass 'touch' for a 44px target. */
  size?: 'sm' | 'touch';
  /**
   * The predict-before-solve gate's persisted preference, when the host has one.
   *
   * It lives HERE because this popover is the app's one place for local,
   * per-browser practice preferences (it already owns the assistance ladder),
   * and because it is the only control present in both the desktop toolbar and
   * the phone action bar — so the "Don't ask again" button inside the gate has
   * somewhere to point that exists on every layout. Omit both props and the row
   * is not rendered at all.
   */
  planGate?: boolean;
  onPlanGateChange?: (next: boolean) => void;
  /**
   * Compact trigger for the phone action bar: just the sliders glyph plus a
   * tiny level marker, so Run/Submit get the width. The current preset stays
   * one tap away in the popover (and in the aria-label/tooltip).
   */
  iconOnly?: boolean;
}) {
  const { level, overrides } = settings;

  const selectPreset = (lvl: AssistanceLevel) => {
    onChange({ level: lvl, overrides: presetToOverrides(lvl) });
  };

  const toggle = (key: keyof AssistanceOverrides, value: boolean) => {
    const next: AssistanceOverrides = { ...overrides, [key]: value };
    onChange({ level: matchLevel(next), overrides: next });
  };

  const activeLabel = level === 'custom' ? 'Custom' : LEVEL_META[level].label;

  const trigger = iconOnly ? (
    <Button
      variant="outline"
      size={size === 'touch' ? 'touchIcon' : 'icon'}
      // `icon` is h-9; the short-landscape bar is otherwise h-8 (`sm`), so
      // match it. Desktop never renders iconOnly.
      className={cn('relative shrink-0', size !== 'touch' && 'h-8 w-9')}
      aria-label={`Editor assistance: ${activeLabel}`}
      title={`Editor assistance: ${activeLabel}`}
    >
      <SlidersHorizontal className="h-4 w-4" />
      {/* Level marker so "which preset am I on?" survives the compact form. */}
      <span
        aria-hidden
        className="absolute right-1.5 top-1 text-[9px] font-bold leading-none text-primary"
      >
        {level === 'custom' ? '•' : level}
      </span>
    </Button>
  ) : (
    <Button variant="outline" size={size} className="min-w-0 gap-1.5">
      <SlidersHorizontal className="h-4 w-4" />
      <span className="hidden sm:inline">Assist:</span>
      {/* Truncates rather than clipping mid-glyph in a narrow grid cell. */}
      <span className="truncate">{activeLabel}</span>
    </Button>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">Editor assistance</p>
            <p className="text-xs text-muted-foreground">
              Practice anywhere from a blank whiteboard to a full IDE.
            </p>
          </div>

          {/* Segmented preset control */}
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/50 p-1">
            {LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => selectPreset(lvl)}
                title={LEVEL_META[lvl].blurb}
                className={cn(
                  'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-xs font-medium transition-colors',
                  level === lvl
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="text-[10px] opacity-70">{lvl}</span>
                {LEVEL_META[lvl].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {level === 'custom'
              ? 'Custom — individual overrides applied.'
              : LEVEL_META[level].blurb}
          </p>

          {planGate !== undefined && onPlanGateChange && (
            <label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border py-2 pt-3 text-sm">
              <span>
                Plan before solving
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Predict your approach and complexity before the editor opens.
                  Takes effect on the next problem.
                </span>
              </span>
              <Switch
                checked={planGate}
                onCheckedChange={onPlanGateChange}
                className="mt-0.5 shrink-0"
              />
            </label>
          )}

          {/* Individual override toggles */}
          <div className="space-y-2.5 border-t border-border pt-3">
            {OVERRIDE_META.map(({ key, label }) => (
              <label
                key={key}
                // py-2 so the whole 36px row is a hittable target, not just the
                // 36×20 switch.
                className="flex cursor-pointer items-center justify-between py-2 text-sm"
              >
                <span>{label}</span>
                <Switch
                  checked={overrides[key]}
                  onCheckedChange={(v) => toggle(key, v)}
                />
              </label>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

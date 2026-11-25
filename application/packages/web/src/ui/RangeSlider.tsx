import { forwardRef, type InputHTMLAttributes } from 'react';

/**
 * @catalog RangeSlider
 * use: a continuous numeric adjustment (length, spread, timeline scrub, stroke option) where live drag feedback helps; pair with an accessible label (`aria-label` or `<label htmlFor>`) and a visible readout or typed twin.
 * never: a raw `<input type="range">`; a slider for a 0 to 10 or 1 to 10 wellness scale (use `ScaleTiles` or `MoodScale`).
 */
export const RangeSlider = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  function RangeSlider({ className = '', style, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type="range"
        {...rest}
        style={{ accentColor: 'rgb(var(--pn-accent))', ...style }}
        className={`h-1.5 cursor-pointer rounded-full bg-track accent-accent disabled:cursor-default disabled:opacity-40${className ? ` ${className}` : ''}`}
      />
    );
  },
);

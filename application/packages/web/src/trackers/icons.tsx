import type { CSSProperties, ReactNode } from 'react';
import {
  Bandaids,
  Barbell,
  CheckSquare,
  Circle,
  Coffee,
  DotsThree,
  Drop,
  Eyedropper,
  Flask,
  Footprints,
  Gauge,
  Heart,
  Heartbeat,
  Lightning,
  Monitor,
  Moon,
  MoonStars,
  PersonSimpleRun,
  Pill,
  PuzzlePiece,
  Smiley,
  SmileySad,
  Syringe,
  Target,
  Users,
  Wind,
  type Icon,
} from '../icons';
import type { MedicationForm } from '../trackerTypes';

/** One glyph per medication form, shared by Settings and the medication rows. */
const FORM_GLYPHS: Record<MedicationForm, Icon> = {
  tablet: Circle,
  capsule: Pill,
  liquid: Flask,
  injection: Syringe,
  inhaler: Wind,
  patch: Bandaids,
  drops: Eyedropper,
  other: DotsThree,
};

/** A medication's glyph: the one of its form, or a pill without one. */
export function MedicationGlyph({ form, size = 12, className, style }: { form?: MedicationForm; size?: number; className?: string; style?: CSSProperties }) {
  const Glyph = form ? FORM_GLYPHS[form] : Pill;
  return <Glyph size={size} className={className} style={style} aria-hidden="true" />;
}

/**
 * Compact glyphs shown on filled tracker pills. Keys match the built-in
 * tracker IDs used in `trackerSettings.activeBuiltins`. Weight comes from
 * the sitewide IconDefaults provider.
 */
export const TRACKER_ICONS: Record<string, ReactNode> = {
  mood: <Smiley />,
  emotions: <Heart />,
  factors: <PuzzlePiece />,
  habits: <CheckSquare />,
  sleep: <Moon />,
  activity: <PersonSimpleRun />,
  energy: <Lightning />,
  focus: <Target />,
  sleepScore: <MoonStars />,
  heartRate: <Heartbeat />,
  bloodPressure: <Gauge />,
  medication: <Pill />,
  weight: <Barbell />,
  steps: <Footprints />,
  water: <Drop />,
  screenTime: <Monitor />,
  caffeine: <Coffee />,
  pain: <SmileySad />,
  social: <Users />,
};

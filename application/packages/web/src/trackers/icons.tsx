import type { ReactNode } from 'react';
import {
  Barbell,
  CheckSquare,
  Coffee,
  Drop,
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
  Target,
  Users,
} from '../icons';

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

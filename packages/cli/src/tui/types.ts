/**
 * TUI type definitions
 */

import type { Widgets } from 'neo-blessed';
import type { TuiSnapshot } from './state.js';

export type TuiScreen = {
  name: string;
  mount: (screen: Widgets.Screen) => void;
  update: (snapshot: TuiSnapshot) => void;
  destroy: () => void;
  focus?: () => void;
};

export type TuiActions = {
  runScout?: () => Promise<void>;
  runQa?: () => Promise<void>;
};

// Re-export TuiSnapshot for convenience
export type { TuiSnapshot } from './state.js';

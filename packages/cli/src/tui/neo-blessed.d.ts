/**
 * Type declarations for neo-blessed
 *
 * Neo-blessed is a fork of blessed with modern Node.js support.
 * This is a minimal type definition for the features we use.
 */

declare module 'neo-blessed' {
  export namespace Widgets {
    interface NodeOptions {
      parent?: Node;
      top?: number | string;
      left?: number | string;
      right?: number | string;
      bottom?: number | string;
      width?: number | string;
      height?: number | string;
      hidden?: boolean;
      style?: StyleOptions;
    }

    interface StyleOptions {
      fg?: string;
      bg?: string;
      bold?: boolean;
      underline?: boolean;
      border?: {
        fg?: string;
        bg?: string;
      };
      selected?: {
        fg?: string;
        bg?: string;
        bold?: boolean;
      };
      item?: {
        fg?: string;
        bg?: string;
      };
    }

    interface BoxOptions extends NodeOptions {
      content?: string;
      label?: string;
      border?: { type?: 'line' | 'bg' } | 'line' | 'bg';
      padding?: number | { left?: number; right?: number; top?: number; bottom?: number };
      tags?: boolean;
      scrollable?: boolean;
      alwaysScroll?: boolean;
      scrollbar?: {
        ch?: string;
        inverse?: boolean;
        style?: { bg?: string; fg?: string };
      };
      mouse?: boolean;
      keys?: boolean;
      vi?: boolean;
      input?: boolean;
      inputOnFocus?: boolean;
    }

    interface ListOptions extends BoxOptions {
      items?: string[];
      interactive?: boolean;
      invertSelected?: boolean;
    }

    interface TextboxOptions extends BoxOptions {
      inputOnFocus?: boolean;
    }

    interface ScreenOptions {
      smartCSR?: boolean;
      title?: string;
      fullUnicode?: boolean;
      tags?: boolean;
      dockBorders?: boolean;
    }

    interface Node {
      hidden: boolean;
      show(): void;
      hide(): void;
      focus(): void;
      setFront(): void;
      destroy(): void;
      on(event: string, callback: (...args: any[]) => void): void;
      removeAllListeners(event?: string): void;
    }

    interface BoxElement extends Node {
      setContent(content: string): void;
      getContent(): string;
      setLabel(label: string): void;
      pushLine(line: string): void;
      insertBottom(line: string): void;
      setScrollPerc(perc: number): void;
      getScrollPerc(): number;
      scroll(offset: number): void;
      scrollTo(index: number): void;
      getScrollHeight(): number;
      height: number;
      width: number;
    }

    interface ListElement extends BoxElement {
      select(index: number): void;
      selected: number;
      setItems(items: string[]): void;
      addItem(item: string): void;
      getItem(index: number): BoxElement;
      items: BoxElement[];
      removeItem(index: number): void;
    }

    interface TextboxElement extends BoxElement {
      setValue(value: string): void;
      getValue(): string;
      clearValue(): void;
      readInput(callback?: (err: any, value?: string) => void): void;
      submit: string;
    }

    // Alias for backwards compatibility
    type Box = BoxElement;

    interface Screen extends Node {
      render(): void;
      key(keys: string | string[], callback: (ch: string, key: KeyEvent) => void): void;
      width: number;
      height: number;
      program: {
        showCursor(): void;
        hideCursor(): void;
      };
    }

    interface KeyEvent {
      full: string;
      name: string;
      ctrl: boolean;
      shift: boolean;
      meta: boolean;
    }
  }

  export function screen(options?: Widgets.ScreenOptions): Widgets.Screen;
  export function box(options?: Widgets.BoxOptions): Widgets.BoxElement;
  export function list(options?: Widgets.ListOptions): Widgets.ListElement;
  export function textbox(options?: Widgets.TextboxOptions): Widgets.TextboxElement;
  export function textarea(options?: Widgets.TextboxOptions): Widgets.TextboxElement;

  const blessed: {
    screen: typeof screen;
    box: typeof box;
    list: typeof list;
    textbox: typeof textbox;
    textarea: typeof textarea;
    Widgets: typeof Widgets;
  };

  export default blessed;
}

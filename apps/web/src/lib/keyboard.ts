import { useEffect, useState } from "react";

/** The part of the window the on-screen keyboard covers, in px (0 when it is closed). */
export function keyboardInset(innerHeight: number, viewHeight: number, viewTop: number): number {
  const covered = Math.round(innerHeight - viewHeight - viewTop);
  // Small gaps come from browser bars and rounding, not a keyboard.
  return covered > 40 ? covered : 0;
}

/**
 * The visible height of the page and how much of the bottom the keyboard hides, kept up to date
 * while `active`. Phones (iOS Safari above all) keep fixed sheets pinned behind the keyboard,
 * so a bottom sheet uses this to sit just above it instead.
 */
export function useKeyboardInset(active: boolean): { inset: number; height: number | null } {
  const [state, setState] = useState<{ inset: number; height: number | null }>({
    inset: 0,
    height: null,
  });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) {
      setState({ inset: 0, height: null });
      return;
    }
    const update = () =>
      setState({
        inset: keyboardInset(window.innerHeight, vv.height, vv.offsetTop),
        height: Math.round(vv.height),
      });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return state;
}

// The narrow drawer's focus (SplitView.tsx; review N12): the drawer held focus, and when it closes its panel is gone, so
// the page's main view takes focus back (on every page; the Console's input line then takes it from there).

/** Whether the main view takes focus: the drawer was open (`wasDrawer`) and now isn't. */
export function mainTakesFocus(wasDrawer: boolean | null, drawer: boolean): boolean {
  return wasDrawer === true && !drawer;
}

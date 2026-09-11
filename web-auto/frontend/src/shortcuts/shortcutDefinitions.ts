export interface ShortcutDefinition {
  keys: string[];
  descriptionKey: string;
  manualOnly?: boolean;
}

export interface ShortcutSection {
  titleKey: string;
  items: ShortcutDefinition[];
}

/** Deliberate workspace commands only; native form/accessibility keys are omitted. */
export const WORKSPACE_SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    titleKey: 'shortcuts_navigation',
    items: [
      { keys: ['A', '←', '↑'], descriptionKey: 'shortcut_previous_image' },
      { keys: ['D', '→', '↓'], descriptionKey: 'shortcut_next_image' },
      { keys: ['F'], descriptionKey: 'shortcut_fit_canvas' },
      { keys: ['Alt', 'shortcut_key_drag'], descriptionKey: 'shortcut_pan_canvas' },
      { keys: ['Esc'], descriptionKey: 'shortcut_escape' },
    ],
  },
  {
    titleKey: 'shortcuts_manual_tools',
    items: [
      { keys: ['V'], descriptionKey: 'shortcut_pointer' },
      { keys: ['B'], descriptionKey: 'shortcut_box', manualOnly: true },
      { keys: ['P'], descriptionKey: 'shortcut_polygon', manualOnly: true },
      { keys: ['Enter'], descriptionKey: 'shortcut_finish_polygon', manualOnly: true },
      { keys: ['1–9'], descriptionKey: 'shortcut_select_class' },
      { keys: ['Delete / Backspace'], descriptionKey: 'shortcut_delete_annotation', manualOnly: true },
    ],
  },
  {
    titleKey: 'shortcuts_save_history',
    items: [
      { keys: ['Ctrl', 'S'], descriptionKey: 'shortcut_save', manualOnly: true },
      { keys: ['Ctrl', 'Z'], descriptionKey: 'shortcut_undo', manualOnly: true },
      { keys: ['Ctrl', 'Y'], descriptionKey: 'shortcut_redo', manualOnly: true },
    ],
  },
  {
    titleKey: 'shortcuts_ai_segmentation',
    items: [
      { keys: ['Ctrl', 'A'], descriptionKey: 'shortcut_ai_mode', manualOnly: true },
      { keys: ['W'], descriptionKey: 'shortcut_ai_point_type', manualOnly: true },
      { keys: ['shortcut_key_left_click'], descriptionKey: 'shortcut_ai_point', manualOnly: true },
      { keys: ['shortcut_key_right_click'], descriptionKey: 'shortcut_ai_finish', manualOnly: true },
    ],
  },
];

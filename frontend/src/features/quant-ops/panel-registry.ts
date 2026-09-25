/** Panel IDs from docs/integration/dashboard-v2/quant-operations/CONDOR_V2_FULL_DASHBOARD_SPEC.md Appendix A. */
export const ORIGINAL_CAPITAL_PANELS = ['C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15','C16'] as const;
export const ORIGINAL_BOT_PANELS = ['B01','B02','B03','B04','B05','B06','B07','B08','B09','B10','B11','B12','B13','B14','B15','B16','B17','B18','B19','B20','B21','B22','B23','B24','B25'] as const;
export const ORIGINAL_SHELL_PANELS = ['S01','S02','S03','S04','S05','S06'] as const;

export const CAPITAL_PANELS = [...ORIGINAL_CAPITAL_PANELS, 'C17','C18','C19','C20','C21','C22','C23','C24','C25','C26','C27','C28'] as const;
export const BOT_PANELS = [...ORIGINAL_BOT_PANELS, 'B26','B27','B28','B29','B30','B31','B32','B33','B34','B35','B36','B37','B38','B39'] as const;
export const SHELL_PANELS = [...ORIGINAL_SHELL_PANELS, 'S07','S08'] as const;
export const QUANT_PANELS = [...SHELL_PANELS, ...CAPITAL_PANELS, ...BOT_PANELS] as const;

/** Capital rows 1–3 (spec §7.1) are the first implementation slice. */
export const CAPITAL_SLICE_ROWS_1_3 = ['C01','C04','C05','C17','C09','C10','C02','C03','C18','C06','C19'] as const;

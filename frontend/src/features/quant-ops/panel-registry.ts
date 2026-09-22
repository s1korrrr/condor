export const CAPITAL_PANELS = ['C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15','C16'] as const;
export const BOT_PANELS = ['B01','B02','B03','B04','B05','B06','B07','B08','B09','B10','B11','B12','B13','B14','B15','B16','B17','B18','B19','B20','B21','B22','B23','B24','B25'] as const;
export const SHELL_PANELS = ['S01','S02','S03','S04','S05','S06'] as const;
export const QUANT_PANELS = [...SHELL_PANELS, ...CAPITAL_PANELS, ...BOT_PANELS] as const;

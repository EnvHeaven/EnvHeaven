export interface EnvHeavenPreferences {
    autoStartUi: boolean;
}
export declare function loadPreferences(): Promise<EnvHeavenPreferences | null>;
export declare function savePreferences(prefs: EnvHeavenPreferences): Promise<void>;

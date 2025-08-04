// Temporary file to allow compilation
export interface SouthPIWebAPISettings {
  throttling: {
    maxReadInterval: number;
    readDelay: number;
    overlap: number;
    maxInstantPerItem: boolean;
  };
  url: string;
  dataServerWebId: string;
  username: string;
  password: string | null;
  acceptUnauthorized: boolean;
  timeout: number;
  retryInterval: number;
}

export interface SouthPIWebAPIItemSettings {
  pointWebId: string;
}

// Re-export everything from the old file if it exists
export * from './south-settings.model.ts';

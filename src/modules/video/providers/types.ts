export type VideoProviderId =
  | 'dailymotion'
  | 'eporner'
  | 'redtube'
  | 'pornhub'
  | 'xnxx'
  | 'generic_web'
  | (string & {});

export interface VideoProviderCapabilities {
  searchSupported: boolean;
  downloadSupported: boolean;
  metadataSupported: boolean;
}

export interface NormalizedVideoResult {
  videoRef?: string | undefined;
  provider: string;
  id: string;
  title: string;
  durationSeconds?: number | undefined;
  uploader?: string | undefined;
  thumbnailUrl?: string | undefined;
  webpageUrl: string;
  downloadable: boolean;
  metadata?: Record<string, unknown> | undefined;
}

export interface VideoSearchOptions {
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface VideoResolveOptions {
  signal?: AbortSignal | undefined;
}

export interface VideoProvider {
  readonly id: VideoProviderId;
  readonly isAdult: boolean;
  readonly capabilities: VideoProviderCapabilities;
  search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]>;
  resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined>;
  isUrlAllowed(url: string): boolean;
}

export type VideoRegistrySearchSource =
  | 'auto'
  | 'web'
  | 'dailymotion'
  | 'adult'
  | 'pornhub'
  | 'xnxx'
  | 'eporner'
  | 'redtube';

export interface VideoRegistrySearchOptions {
  source?: VideoRegistrySearchSource | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

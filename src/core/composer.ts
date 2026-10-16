export type Composition={facts:Record<string,unknown>;canonical:string;intent:'chat'|'spoken'|'tool'};
/** Tool templates are canonical: no extra model call and no opportunity to change facts. */
export function compose(input:Composition):string{return input.canonical;}

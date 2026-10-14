export type Expanded = boolean

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { expanded: Expanded }
  }
}

export function resolveApiPort(railwayPort: number | undefined, apiPort: number): number {
  return railwayPort ?? apiPort
}

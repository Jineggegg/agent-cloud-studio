/** Used across the studio module, and by the workbench module through the barrel, as the iOS-style activity indicator: eight fading spokes that step around. */
export function StudioSpinner({ size = 18, label }: { size?: number; label?: string }) {
  return <span className="studio-spinner" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    style={{ width: size, height: size }}>
    {Array.from({ length: 8 }, (_, index) => <i key={index} style={{ transform: `rotate(${index * 45}deg)`, opacity: 0.25 + index * 0.0937 }} />)}
  </span>;
}

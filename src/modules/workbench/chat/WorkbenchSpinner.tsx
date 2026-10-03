/**
 * Used across the workbench chat column (tool rows, run status row, loading states) as the iOS activity
 * indicator: eight fading spokes that step around. Same drawing as Studio's spinner, so the two read as one product.
 */
export function WorkbenchSpinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="wbc-spinner"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <i key={index} style={{ transform: `rotate(${index * 45}deg)`, opacity: 0.25 + index * 0.0937 }} />
      ))}
    </span>
  );
}

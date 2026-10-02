/**
 * Used by StudioHomeScreen as the home wallpaper: one calm gradient of a few fixed colours (near-white by day,
 * ink by night) under a light film grain, drawn in CSS (studio.css, .home-wallpaper). It replaced a WebGL colour
 * field, whose canvas showed solid black wherever the GPU context failed or was lost.
 */
export function StudioFluidBackground() {
  return <div className="home-wallpaper" aria-hidden="true" />;
}

# Aldunis brand assets

`aldunis-logo-selected-ribbon.png` is the selected source artwork supplied for
the application identity. Keep it as the reference board rather than using the
whole image in product chrome.

`build/aldunis-mark-light.png` and `build/aldunis-mark-dark.png` present the
exact white-tile and dark-tile treatments from the supplied artwork. The
resolved application theme selects the matching in-product mark and favicon;
system mode follows the operating-system theme.

Both files are 1024 × 1024 raster extracts because the supplied artwork does not
contain vector paths. Electron Builder reuses the light treatment instead of
shipping a third byte-identical mark.

The web shell loads the 128 × 128 derivatives from `public/`. They preserve
ample resolution for the compact sidebar mark and favicon without copying,
decoding, or transferring the packaging-scale artwork in every renderer build.

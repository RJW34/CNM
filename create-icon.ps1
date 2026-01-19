Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "3870.png"
$destPath = Join-Path $PSScriptRoot "client\web\apple-touch-icon.png"

# Load the source tileset
$srcImage = [System.Drawing.Image]::FromFile($srcPath)

# Network Machine building - full orange roof with wifi symbol
# Trim ALL purple - be precise
$srcRect = New-Object System.Drawing.Rectangle(12, 352, 103, 64)

# Create destination image at 180x180 for iOS
$destSize = 180
$destImage = New-Object System.Drawing.Bitmap($destSize, $destSize)
$graphics = [System.Drawing.Graphics]::FromImage($destImage)

# High quality scaling
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half

# Fill with a nice background color (emerald green to match theme)
$bgColor = [System.Drawing.Color]::FromArgb(255, 11, 115, 44)
$graphics.Clear($bgColor)

# Calculate centered position maintaining aspect ratio
$scale = [Math]::Min($destSize / $srcRect.Width, $destSize / $srcRect.Height) * 0.85
$scaledWidth = $srcRect.Width * $scale
$scaledHeight = $srcRect.Height * $scale
$destX = ($destSize - $scaledWidth) / 2
$destY = ($destSize - $scaledHeight) / 2

$destRect = New-Object System.Drawing.RectangleF($destX, $destY, $scaledWidth, $scaledHeight)

# Draw the Pokemon Center sprite onto the icon
$graphics.DrawImage($srcImage, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

# Save as PNG
$destImage.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Cleanup
$graphics.Dispose()
$destImage.Dispose()
$srcImage.Dispose()

Write-Host "Created iOS app icon at: $destPath"

# Local test fixtures only. Contains no real accounts or customer information.
Add-Type -AssemblyName System.Drawing
$destination = Join-Path $PSScriptRoot '../reports'
[System.IO.Directory]::CreateDirectory($destination) | Out-Null
$cases = @(
  @{Name='statement-normal'; Lines=@('SYNTHETIC TEST - NOT A REAL ACCOUNT', 'Currency: TWD', '2026-09-01 Render.com renewal expense 230', '2026-09-02 Grocery expense 970', '2026-09-05 Salary received income 68981')},
  @{Name='statement-transfer'; Lines=@('SYNTHETIC TEST - NOT A REAL ACCOUNT', 'Currency: TWD', '2026-09-01 Credit card payment 26104', '2026-09-02 Transfer to my other account 1000', '2026-09-03 Lunch expense 120')},
  @{Name='statement-incomplete'; Lines=@('SYNTHETIC TEST - NOT A REAL ACCOUNT', 'Currency: TWD - Year not shown', '09/01 Render.com renewal expense 230', '09/02 Grocery expense [unreadable amount]')}
)
foreach ($case in $cases) {
  $bitmap = [System.Drawing.Bitmap]::new(1200,430)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $font = [System.Drawing.Font]::new('Arial',24)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $y=25
    foreach ($line in $case.Lines) { $graphics.DrawString($line,$font,[System.Drawing.Brushes]::Black,25,$y); $y+=70 }
    $bitmap.Save((Join-Path $destination ($case.Name+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

# Opens a .docx in Microsoft Word (read-only, through COM) and prints what Word sees as JSON:
# counts of paragraphs, tables, pictures and comments, the header and footer text and the page
# setup. Used by e2e/convert.ts to check that Colo's exports open in Word; Windows with Word only.
#
#   powershell -ExecutionPolicy Bypass -File scripts/check-docx-in-word.ps1 -Path C:\path\file.docx
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = "Stop"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $null
try {
  # ConfirmConversions: false, ReadOnly: true, AddToRecentFiles: false
  $doc = $word.Documents.Open($Path, $false, $true, $false)
  $comments = @($doc.Comments)
  $section = $doc.Sections.Item(1)
  $headings = @($doc.Paragraphs | Where-Object { $_.OutlineLevel -lt 10 }).Count
  $result = [ordered]@{
    paragraphs = $doc.Paragraphs.Count
    headings = $headings
    tables = $doc.Tables.Count
    pictures = $doc.InlineShapes.Count
    comments = $comments.Count
    replies = @($comments | Where-Object { $_.Ancestor -ne $null }).Count
    resolved = @($comments | Where-Object { $_.Done }).Count
    header = $section.Headers.Item(1).Range.Text.Trim()
    footer = $section.Footers.Item(1).Range.Text.Trim()
    pageWidth = $doc.PageSetup.PageWidth
    pageHeight = $doc.PageSetup.PageHeight
    orientation = $doc.PageSetup.Orientation
    pages = $doc.ComputeStatistics(2)
  }
  $result | ConvertTo-Json -Compress
} finally {
  # Never leave Word waiting on a prompt.
  if ($doc) { $doc.Close([ref]0) }
  $word.Quit([ref]0)
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

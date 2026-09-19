# Rebuilds test/convert/fixtures/word-features.docx in Microsoft Word through COM (Windows only).
# The file exercises everything the DOCX reader maps: styles, character formatting, lists,
# merged table cells, an image, a link, page setup, header/footer page fields, comments with a
# reply and a resolved one, a footnote, tracked changes, a text box and a checkbox.
#
# Word's user name is never changed (it is the machine owner's identity, stored in the
# registry). Comment and revision authors are rewritten in the saved file instead, and the
# owner's name is removed from its properties.
#
#   powershell -ExecutionPolicy Bypass -File scripts/docx-fixtures.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "test\convert\fixtures\word-features.docx"
$image = Join-Path $env:TEMP "colo-fixture-image.png"

# A 400x200 PNG: blue with a yellow block.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 400, 200
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(26, 115, 232))
$graphics.FillRectangle([System.Drawing.Brushes]::Gold, 100, 50, 200, 100)
$bitmap.Save($image, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$owner = $word.UserName
$doc = $null
function Step([string]$name) { Write-Output "  $name" }
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection

  # Page setup: Letter landscape, 1 in top/bottom, 0.75 in left/right.
  $setup = $doc.PageSetup
  $setup.PageWidth = 612; $setup.PageHeight = 792
  $setup.Orientation = 1
  $setup.TopMargin = 72; $setup.BottomMargin = 72; $setup.LeftMargin = 54; $setup.RightMargin = 54

  # Header: text on the left, "Page X of Y" on the right; footer: text on the left.
  $header = $doc.Sections.Item(1).Headers.Item(1).Range
  $header.Text = "Colo fixture`t`tPage "
  $end = $header.Duplicate; $end.Collapse(0); $end.Fields.Add($end, 33) | Out-Null   # wdFieldPage
  $header = $doc.Sections.Item(1).Headers.Item(1).Range
  $end = $header.Duplicate; $end.Collapse(0); $end.InsertAfter(" of ")
  $end = $doc.Sections.Item(1).Headers.Item(1).Range; $end.Collapse(0); $end.Fields.Add($end, 26) | Out-Null   # wdFieldNumPages
  $doc.Sections.Item(1).Footers.Item(1).Range.Text = "Confidential"

  function Para([string]$text, [int]$style) {
    $sel.Style = $doc.Styles.Item($style)
    $sel.TypeText($text)
    $sel.TypeParagraph()
  }
  function Run([string]$text, [scriptblock]$format) {
    & $format
    $sel.TypeText($text)
    $sel.Font.Reset()
  }

  Para "Quarterly report" -63          # Title
  Para "Introduction" -2               # Heading 1

  # Character formatting in one Normal paragraph.
  $sel.Style = $doc.Styles.Item(-1)
  Run "Bold" { $sel.Font.Bold = 1 }; $sel.TypeText(" ")
  Run "italic" { $sel.Font.Italic = 1 }; $sel.TypeText(" ")
  Run "underlined" { $sel.Font.Underline = 1 }; $sel.TypeText(" ")
  Run "struck" { $sel.Font.StrikeThrough = 1 }; $sel.TypeText(" H")
  Run "2" { $sel.Font.Subscript = 1 }; $sel.TypeText("O x")
  Run "3" { $sel.Font.Superscript = 1 }; $sel.TypeText(" ")
  Run "red" { $sel.Font.Color = 255 }; $sel.TypeText(" ")                       # BGR: red
  Run "Times 14" { $sel.Font.Name = "Times New Roman"; $sel.Font.Size = 14 }; $sel.TypeText(" ")
  Run "mono" { $sel.Font.Name = "Courier New" }; $sel.TypeText(" ")
  $sel.TypeText("highlighted")        # highlighted at the end: typing would carry it on
  $sel.TypeParagraph()

  $sel.Style = $doc.Styles.Item(-1)
  $sel.ParagraphFormat.Alignment = 1; $sel.TypeText("Centred paragraph"); $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 2; $sel.TypeText("Right paragraph"); $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 0; $sel.ParagraphFormat.LeftIndent = 36; $sel.TypeText("Indented paragraph"); $sel.TypeParagraph()
  $sel.ParagraphFormat.LeftIndent = 0

  Para "Lists" -3                      # Heading 2
  Para "First bullet" -49              # List Bullet
  Para "Nested bullet" -55             # List Bullet 2
  Para "Second bullet" -49
  $sel.Style = $doc.Styles.Item(-1)
  $sel.Range.ListFormat.ApplyOutlineNumberDefault()   # multi-level numbering
  $sel.TypeText("First number"); $sel.TypeParagraph()
  # A level set before typing lands on the next paragraph, so each is set after its text.
  $sel.TypeText("Nested number"); $sel.Range.ListFormat.ListLevelNumber = 2; $sel.TypeParagraph()
  $sel.TypeText("Second number"); $sel.Range.ListFormat.ListLevelNumber = 1; $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.TypeText(" Done task")
  $start = $sel.Paragraphs.Item(1).Range
  $start.Collapse(1)
  $cc = $doc.ContentControls.Add(8, $start)                        # checkbox, before the text
  $cc.Checked = $true
  $sel.EndKey(5) | Out-Null
  $sel.TypeParagraph()

  Para "Table" -4                      # Heading 3
  $sel.Style = $doc.Styles.Item(-1)
  $table = $doc.Tables.Add($sel.Range, 3, 3)
  $table.Borders.Enable = 1
  $cells = @(@("Name", "Role", "Notes"), @("Alex", "Writer", "Spans rows"), @("Sam", "Editor", ""))
  for ($r = 1; $r -le 3; $r++) { for ($c = 1; $c -le 3; $c++) { $table.Cell($r, $c).Range.Text = $cells[$r - 1][$c - 1] } }
  $table.Rows.Item(1).HeadingFormat = -1
  $table.Rows.Item(1).Range.Font.Bold = 1
  $table.Cell(2, 3).Merge($table.Cell(3, 3))                      # vertical merge
  $table.Cell(3, 1).Merge($table.Cell(3, 2))                      # horizontal merge
  $sel.EndKey(6) | Out-Null

  $sel.ParagraphFormat.Alignment = 1
  $sel.InlineShapes.AddPicture($image) | Out-Null
  $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 0

  $sel.TypeText("Visit the ")
  $doc.Hyperlinks.Add($sel.Range, "https://example.com/", $null, $null, "Colo website") | Out-Null
  $sel.TypeText(" for more.")
  $sel.TypeParagraph()
  Para "A quotation worth keeping." -181   # Quote

  $sel.InsertBreak(7)                  # page break
  Para "Review" -2
  $sel.Style = $doc.Styles.Item(-1)
  $sel.TypeText("This claim needs a source here. Old wording stays.")
  $paragraph = $sel.Paragraphs.Item(1).Range
  $sel.TypeParagraph()
  $sel.TypeText("Resolved discussion sentence.")
  $resolvedParagraph = $sel.Paragraphs.Item(1).Range
  $sel.TypeParagraph()

  $find = $paragraph.Duplicate
  $find.Find.Execute("a source") | Out-Null
  Step "comments"
  $comment = $doc.Comments.Add($find, "Please cite this.")
  $comment.Replies.Add($find, "Added a citation.") | Out-Null
  $find2 = $resolvedParagraph.Duplicate
  $find2.Find.Execute("discussion") | Out-Null
  $done = $doc.Comments.Add($find2, "Settled.")
  $done.Done = $true

  Step "footnote"
  $note = $paragraph.Duplicate
  $note.Find.Execute("claim") | Out-Null
  $note.Collapse(0)
  $doc.Footnotes.Add($note, [Type]::Missing, "Footnote text.") | Out-Null

  Step "tracked changes"
  # Tracked changes: one insertion, one deletion.
  $doc.TrackRevisions = $true
  $insertAt = $paragraph.Duplicate
  $insertAt.Find.Execute("Old wording") | Out-Null
  $insertAt.Collapse(1)
  $insertAt.InsertBefore("Inserted words. ")
  $deleted = $paragraph.Duplicate
  $deleted.Find.Execute(" stays") | Out-Null
  $deleted.Delete() | Out-Null
  $doc.TrackRevisions = $false

  $mark = $doc.Content
  $mark.Find.Execute("highlighted") | Out-Null
  $mark.HighlightColorIndex = 7

  Step "text box and properties"
  $box = $doc.Shapes.AddTextbox(1, 400, 300, 150, 40)
  $box.TextFrame.TextRange.Text = "Boxed text"

  # Document properties are late-bound; PowerShell reaches them only through InvokeMember.
  $props = $doc.BuiltInDocumentProperties
  $titleProp = [System.__ComObject].InvokeMember("Item", "GetProperty", $null, $props, @("Title"))
  [System.__ComObject].InvokeMember("Value", "SetProperty", $null, $titleProp, @("Quarterly report")) | Out-Null
  # Automation saves can stall on some machines, so the document is read as Flat OPC (one XML
  # file holding every part) and packaged as a .docx here instead of calling SaveAs.
  Step "save"
  $flat = [xml]$doc.WordOpenXML
} finally {
  # Never leave a prompt behind: close without saving and quit without saving.
  if ($doc) { $doc.Close([ref]0) }
  $word.Quit([ref]0)
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  Remove-Item $image -ErrorAction SilentlyContinue
}

# Flat OPC -> .docx: each pkg:part becomes a zip entry; [Content_Types].xml lists their types.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$ns = New-Object System.Xml.XmlNamespaceManager($flat.NameTable)
$ns.AddNamespace("pkg", "http://schemas.microsoft.com/office/2006/xmlPackage")
if (Test-Path $out) { Remove-Item $out }
$zip = [System.IO.Compression.ZipFile]::Open($out, "Create")
try {
  $types = New-Object System.Text.StringBuilder
  [void]$types.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">')
  foreach ($part in $flat.SelectNodes("//pkg:part", $ns)) {
    $name = $part.GetAttribute("name", "http://schemas.microsoft.com/office/2006/xmlPackage").TrimStart("/")
    $type = $part.GetAttribute("contentType", "http://schemas.microsoft.com/office/2006/xmlPackage")
    [void]$types.Append("<Override PartName=`"/$name`" ContentType=`"$type`"/>")
    $stream = $zip.CreateEntry($name).Open()
    try {
      $binary = $part.SelectSingleNode("pkg:binaryData", $ns)
      if ($binary) { $bytes = [Convert]::FromBase64String($binary.InnerText) }
      else { $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + $part.SelectSingleNode("pkg:xmlData", $ns).InnerXml) }
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Close() }
  }
  [void]$types.Append("</Types>")
  $stream = $zip.CreateEntry("[Content_Types].xml").Open()
  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($types.ToString())
  $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
} finally {
  $zip.Dispose()
}

# Rewrite authors inside the saved package: the reply is Alex's, everything else Sam's; the
# document properties lose the machine owner's name.
Step "authors"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, "Update")
try {
  $owner = [System.Security.SecurityElement]::Escape($owner)
  foreach ($entry in @($zip.Entries)) {
    if ($entry.FullName -notmatch '\.xml$') { continue }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $xml = $reader.ReadToEnd(); $reader.Close()
    $next = $xml.Replace("w:author=`"$owner`"", 'w:author="Sam Reviewer"').Replace("w15:author=`"$owner`"", 'w15:author="Sam Reviewer"')
    $next = $next -replace '<dc:creator>[^<]*</dc:creator>', '<dc:creator>Colo fixtures</dc:creator>'
    $next = $next -replace '<cp:lastModifiedBy>[^<]*</cp:lastModifiedBy>', '<cp:lastModifiedBy>Colo fixtures</cp:lastModifiedBy>'
    $next = $next -replace '<w:initials>[^<]*</w:initials>', ''
    $next = $next.Replace("w15:userId=`"$owner`"", 'w15:userId="Sam Reviewer"')
    if ($entry.FullName -eq "word/comments.xml") {
      # The reply is the comment whose text is "Added a citation."
      $next = [regex]::Replace($next, '(<w:comment [^>]*?)w:author="Sam Reviewer"([^>]*>(?:(?!</w:comment>).)*Added a citation\.)', '$1w:author="Alex Writer"$2', "Singleline")
      $next = $next -replace 'w:initials="[^"]*"', 'w:initials="SR"'
    }
    if ($next -ne $xml) {
      $name = $entry.FullName
      $entry.Delete()
      $writer = New-Object System.IO.StreamWriter(($zip.CreateEntry($name)).Open(), (New-Object System.Text.UTF8Encoding $false))
      $writer.Write($next); $writer.Close()
    }
  }
} finally {
  $zip.Dispose()
}
Write-Output "saved $out"

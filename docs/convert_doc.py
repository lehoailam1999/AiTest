import os
import re
import sys
import base64
import urllib.request
import urllib.parse

try:
    import docx
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
except ImportError:
    print("Installing python-docx...")
    os.system(f"{sys.executable} -m pip install python-docx")
    import docx
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

def set_cell_background(cell, fill_hex):
    tcPr = cell._element.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=100, bottom=100, left=140, right=140):
    tcPr = cell._element.get_or_add_tcPr()
    tcMar = parse_xml(f'''
        <w:tcMar {nsdecls("w")}>
            <w:top w:w="{top}" w:type="dxa"/>
            <w:bottom w:w="{bottom}" w:type="dxa"/>
            <w:left w:w="{left}" w:type="dxa"/>
            <w:right w:w="{right}" w:type="dxa"/>
        </w:tcMar>
    ''')
    tcPr.append(tcMar)

def set_table_borders(table, color="CBD5E1"):
    tblPr = table._element.xpath('w:tblPr')
    if tblPr:
        borders = parse_xml(f'''
            <w:tblBorders {nsdecls("w")}>
                <w:top w:val="single" w:sz="4" w:space="0" w:color="{color}"/>
                <w:bottom w:val="single" w:sz="6" w:space="0" w:color="{color}"/>
                <w:left w:val="none"/>
                <w:right w:val="none"/>
                <w:insideH w:val="single" w:sz="4" w:space="0" w:color="{color}"/>
                <w:insideV w:val="none"/>
            </w:tblBorders>
        ''')
        tblPr[0].append(borders)

def render_mermaid_to_image(mermaid_code, img_output_path):
    """Render mermaid code to PNG via mermaid.ink API."""
    try:
        graph_bytes = mermaid_code.encode('utf-8')
        base64_bytes = base64.b64encode(graph_bytes)
        base64_string = base64_bytes.decode('ascii')
        url = f"https://mermaid.ink/img/{base64_string}"
        
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                with open(img_output_path, 'wb') as f:
                    f.write(response.read())
                return True
    except Exception as e:
        print(f"Warning: Could not render mermaid image online: {e}")
    return False

def make_callout_box(doc, text_lines, bg_hex="F0F7FF", border_hex="2563EB"):
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    
    cell = table.cell(0, 0)
    cell.width = Inches(6.5)
    set_cell_background(cell, bg_hex)
    set_cell_margins(cell, top=140, bottom=140, left=200, right=180)
    
    tcPr = cell._element.get_or_add_tcPr()
    tcBorders = parse_xml(f'''
        <w:tcBorders {nsdecls("w")}>
            <w:top w:val="none"/>
            <w:left w:val="single" w:sz="24" w:space="0" w:color="{border_hex}"/>
            <w:bottom w:val="none"/>
            <w:right w:val="none"/>
        </w:tcBorders>
    ''')
    tcPr.append(tcBorders)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.line_spacing = 1.15
    
    for i, line in enumerate(text_lines):
        if i > 0:
            p = cell.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.15
        
        format_inline_text(p, line, font_size=10, italic=False)

def format_inline_text(paragraph, text, font_name="Calibri", font_size=10.5, color=RGBColor(0x1F, 0x29, 0x37), italic=False):
    tokens = re.split(r'(\*\*.*?\*\*|`.*?`|\$[^\$]+\$)', text)
    for token in tokens:
        if not token:
            continue
        run = paragraph.add_run()
        run.font.name = font_name
        run.font.size = Pt(font_size)
        run.font.italic = italic
        
        if token.startswith("**") and token.endswith("**"):
            run.text = token[2:-2]
            run.font.bold = True
            run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
        elif token.startswith("`") and token.endswith("`"):
            run.text = token[1:-1]
            run.font.name = "Consolas"
            run.font.size = Pt(font_size - 0.5)
            run.font.color.rgb = RGBColor(0x0F, 0x52, 0xBA)
        elif token.startswith("$") and token.endswith("$"):
            run.text = token[1:-1]
            run.font.name = "Cambria Math"
            run.font.italic = True
            run.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)
        else:
            run.text = token
            run.font.color.rgb = color

def add_ascii_diagram_box(doc, lines):
    """Add ASCII diagrams with exact monospaced 7.5pt Consolas font and perfect alignment."""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    cell.width = Inches(6.5)
    set_cell_background(cell, "0F172A")
    set_cell_margins(cell, top=100, bottom=100, left=120, right=120)
    
    # Determine optimal font size based on max line length
    max_len = max([len(l) for l in lines]) if lines else 0
    font_size = 7.5 if max_len > 65 else (8.0 if max_len > 50 else 8.5)
    
    cp = cell.paragraphs[0]
    cp.paragraph_format.space_before = Pt(0)
    cp.paragraph_format.space_after = Pt(0)
    cp.paragraph_format.line_spacing = Pt(font_size + 2)
    
    for idx, cl in enumerate(lines):
        if idx > 0:
            cp = cell.add_paragraph()
            cp.paragraph_format.space_before = Pt(0)
            cp.paragraph_format.space_after = Pt(0)
            cp.paragraph_format.line_spacing = Pt(font_size + 2)
        crun = cp.add_run(cl)
        crun.font.name = "Consolas"
        crun.font.size = Pt(font_size)
        crun.font.color.rgb = RGBColor(0x38, 0xBD, 0xF8) if any(c in cl for c in ['┌', '┬', '┐', '├', '┼', '┤', '└', '┴', '┘', '─', '│']) else RGBColor(0xF8, 0xFA, 0xFC)
    
    p_space = doc.add_paragraph()
    p_space.paragraph_format.space_before = Pt(0)
    p_space.paragraph_format.space_after = Pt(4)

def convert_md_to_docx(md_path, docx_path):
    doc = Document()
    
    # Page setup - Margins 1 inch
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)
        
        # Header & Footer
        header = section.header
        hp = header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        hrun = hp.add_run("AITest Platform — System Master Documentation")
        hrun.font.name = "Calibri"
        hrun.font.size = Pt(8.5)
        hrun.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)
        
        footer = section.footer
        fp = footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        frun = fp.add_run("Trang 1 / Tài liệu SoT Kiến trúc Hệ thống AITest")
        frun.font.name = "Calibri"
        frun.font.size = Pt(8.5)
        frun.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

    with open(md_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    in_code_block = False
    block_type = ""
    code_lines = []
    
    in_callout = False
    callout_lines = []
    
    table_rows = []
    
    i = 0
    img_counter = 0
    
    while i < len(lines):
        line = lines[i].rstrip("\n")
        
        # Code block handling (text, mermaid, json, env, powershell, etc.)
        if line.startswith("```"):
            if in_code_block:
                # End code block
                in_code_block = False
                
                if block_type == "mermaid":
                    mermaid_code = "\n".join(code_lines)
                    img_path = os.path.join(os.path.dirname(docx_path), f"temp_mermaid_{img_counter}.png")
                    img_counter += 1
                    
                    success = render_mermaid_to_image(mermaid_code, img_path)
                    if success and os.path.exists(img_path):
                        p_img = doc.add_paragraph()
                        p_img.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        p_img.paragraph_format.space_before = Pt(8)
                        p_img.paragraph_format.space_after = Pt(4)
                        p_img.add_run().add_picture(img_path, width=Inches(6.2))
                        
                        p_cap = doc.add_paragraph()
                        p_cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        p_cap.paragraph_format.space_after = Pt(8)
                        run_cap = p_cap.add_run("Sơ đồ Sequence Diagram — Quy trình Sinh & Verify Unit Test")
                        run_cap.font.name = "Calibri"
                        run_cap.font.size = Pt(9)
                        run_cap.font.italic = True
                        run_cap.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
                    else:
                        add_ascii_diagram_box(doc, code_lines)
                else:
                    add_ascii_diagram_box(doc, code_lines)
                
                code_lines = []
                block_type = ""
            else:
                in_code_block = True
                block_type = line[3:].strip().lower()
                code_lines = []
            i += 1
            continue
            
        if in_code_block:
            code_lines.append(line)
            i += 1
            continue

        # Callout handling
        if line.startswith("> "):
            callout_text = line[2:].strip()
            callout_lines.append(callout_text)
            i += 1
            continue
        elif callout_lines:
            make_callout_box(doc, callout_lines, bg_hex="F0F7FF", border_hex="2563EB")
            callout_lines = []
            doc.add_paragraph().paragraph_format.space_after = Pt(4)

        # Horizontal rule
        if line.strip() == "---":
            i += 1
            continue

        # Table handling
        if line.strip().startswith("|") and line.strip().endswith("|"):
            table_rows.append([c.strip() for c in line.strip().split("|")[1:-1]])
            i += 1
            continue
        elif table_rows:
            valid_rows = [r for r in table_rows if not all(re.match(r'^-+$', cell) for cell in r)]
            if valid_rows:
                num_rows = len(valid_rows)
                num_cols = len(valid_rows[0])
                tbl = doc.add_table(rows=num_rows, cols=num_cols)
                tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
                set_table_borders(tbl, "CBD5E1")
                
                col_widths = [Inches(6.5 / num_cols)] * num_cols
                if num_cols == 2:
                    col_widths = [Inches(1.8), Inches(4.7)]
                elif num_cols == 4:
                    col_widths = [Inches(1.3), Inches(1.2), Inches(2.0), Inches(2.0)]
                    
                for r_idx, row_data in enumerate(valid_rows):
                    for c_idx, cell_value in enumerate(row_data):
                        if c_idx < num_cols:
                            cell = tbl.cell(r_idx, c_idx)
                            cell.width = col_widths[c_idx]
                            set_cell_margins(cell, top=100, bottom=100, left=120, right=120)
                            
                            p = cell.paragraphs[0]
                            p.paragraph_format.space_before = Pt(2)
                            p.paragraph_format.space_after = Pt(2)
                            
                            if r_idx == 0:
                                set_cell_background(cell, "1E3A8A")
                                format_inline_text(p, cell_value, font_size=9.5, color=RGBColor(0xFF, 0xFF, 0xFF))
                                p.runs[0].font.bold = True
                            else:
                                bg_color = "F8FAFC" if r_idx % 2 == 1 else "FFFFFF"
                                set_cell_background(cell, bg_color)
                                format_inline_text(p, cell_value, font_size=9.0)
                
                doc.add_paragraph().paragraph_format.space_after = Pt(6)
            table_rows = []

        # Empty line
        if not line.strip():
            i += 1
            continue

        # Headings
        if line.startswith("# "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(16)
            p.paragraph_format.space_after = Pt(6)
            p.paragraph_format.keep_with_next = True
            format_inline_text(p, line[2:].strip(), font_size=20, color=RGBColor(0x0F, 0x17, 0x2A))
            p.runs[0].font.bold = True
        elif line.startswith("## "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.keep_with_next = True
            format_inline_text(p, line[3:].strip(), font_size=14, color=RGBColor(0x1E, 0x3A, 0x8A))
            p.runs[0].font.bold = True
        elif line.startswith("### "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(3)
            p.paragraph_format.keep_with_next = True
            format_inline_text(p, line[4:].strip(), font_size=12, color=RGBColor(0x1E, 0x40, 0xAF))
            p.runs[0].font.bold = True
        elif line.startswith("#### "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(8)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.keep_with_next = True
            format_inline_text(p, line[5:].strip(), font_size=11, color=RGBColor(0x33, 0x41, 0x55))
            p.runs[0].font.bold = True

        # Bullet list
        elif line.strip().startswith("- ") or line.strip().startswith("* "):
            p = doc.add_paragraph(style='List Bullet')
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.15
            content = line.strip()[2:].strip()
            format_inline_text(p, content, font_size=10)

        # Numbered list
        elif re.match(r'^\d+\.\s', line.strip()):
            p = doc.add_paragraph(style='List Number')
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.15
            content = re.sub(r'^\d+\.\s', '', line.strip())
            format_inline_text(p, content, font_size=10)

        # Math formula display ($$...$$)
        elif line.strip().startswith("$$") and line.strip().endswith("$$"):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(6)
            formula_text = line.strip()[2:-2].strip()
            run = p.add_run(formula_text)
            run.font.name = "Cambria Math"
            run.font.size = Pt(11)
            run.font.italic = True
            run.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)

        # Normal Paragraph
        else:
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = 1.15
            format_inline_text(p, line.strip(), font_size=10)

        i += 1

    # Check remaining callout
    if callout_lines:
        make_callout_box(doc, callout_lines, bg_hex="F0F7FF", border_hex="2563EB")
        
    doc.save(docx_path)
    print(f"Successfully generated docx with diagrams: {docx_path}")

if __name__ == "__main__":
    md_file = r"d:\Xlab\AITest\docs\SYSTEM_MASTER_DOCUMENTATION.md"
    docx_file = r"d:\Xlab\AITest\docs\SYSTEM_MASTER_DOCUMENTATION.docx"
    convert_md_to_docx(md_file, docx_file)

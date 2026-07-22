#!/usr/bin/env python3
"""Generate the branded sample PPI report PDF (demonstration only).

Output: las-vegas-pre-purchase-inspection/sample-report/autoclarity-sample-ppi-report.pdf
Content mirrors the HTML sample report. Uses fpdf2 (pure Python).
"""
from fpdf import FPDF

OUT = "las-vegas-pre-purchase-inspection/sample-report/autoclarity-sample-ppi-report.pdf"

NAVY = (10, 18, 38)
BLUE = (47, 107, 255)
BLUESOFT = (120, 150, 220)
AMBER = (200, 130, 20)
RED = (200, 70, 74)
GREEN = (30, 150, 95)
GREY = (110, 120, 140)
TEXT = (30, 36, 52)


class PDF(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*GREY)
        self.cell(0, 8, "AutoClarity - Sample Pre-Purchase Inspection Report (demonstration only)", align="L")
        self.ln(10)

    def footer(self):
        self.set_y(-14)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*GREY)
        self.cell(0, 8, "SAMPLE - DEMONSTRATION ONLY | Not a real customer vehicle | getautoclarity.com", align="C")
        self.set_x(-25)
        self.cell(0, 8, f"Page {self.page_no()}", align="R")


def h2(pdf, text):
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*BLUE)
    pdf.cell(0, 8, text, new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(210, 216, 230)
    y = pdf.get_y()
    pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
    pdf.ln(2)


def para(pdf, text):
    pdf.set_font("Helvetica", "", 10.5)
    pdf.set_text_color(*TEXT)
    pdf.multi_cell(0, 5.4, text)
    pdf.ln(1)


def finding(pdf, sev, color, title, desc, cost=""):
    pdf.set_font("Helvetica", "B", 8.5)
    pdf.set_text_color(*color)
    pdf.cell(24, 5.4, sev.upper())
    pdf.set_text_color(*TEXT)
    pdf.set_font("Helvetica", "B", 10)
    line = title + (f"   [{cost}]" if cost else "")
    pdf.multi_cell(0, 5.4, line, new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(pdf.l_margin + 24)
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(90, 98, 116)
    pdf.multi_cell(0, 5, desc)
    pdf.ln(1.5)


def kv(pdf, pairs):
    pdf.set_font("Helvetica", "", 9.5)
    col_w = (pdf.w - pdf.l_margin - pdf.r_margin) / 2
    label_w = 30
    for i in range(0, len(pairs), 2):
        row = pairs[i:i + 2]
        for k, v in row:
            pdf.set_font("Helvetica", "", 9.5)
            pdf.set_text_color(*GREY)
            pdf.cell(label_w, 6, k)
            pdf.set_text_color(*TEXT)
            pdf.set_font("Helvetica", "B", 9.5)
            pdf.cell(col_w - label_w, 6, v)
        pdf.ln(6)


def main():
    pdf = PDF(format="Letter", unit="mm")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(18, 16, 18)
    pdf.add_page()

    # Sample banner
    pdf.set_fill_color(250, 240, 220)
    pdf.set_draw_color(220, 180, 120)
    pdf.set_text_color(*AMBER)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 9, "SAMPLE REPORT - DEMONSTRATION ONLY | Not a real customer vehicle",
             border=1, align="C", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Title block
    pdf.set_text_color(*NAVY)
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 10, "AutoClarity", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10.5)
    pdf.set_text_color(*GREY)
    pdf.cell(0, 6, "Comprehensive Multi-Point Pre-Purchase Inspection", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, "Report #: SAMPLE-0000 (demo)   |   Inspector: Faheb Brown, Founder & Lead Technician", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # Verdict banner
    pdf.set_fill_color(250, 244, 230)
    pdf.set_draw_color(220, 190, 130)
    y0 = pdf.get_y()
    pdf.rect(pdf.l_margin, y0, pdf.w - pdf.l_margin - pdf.r_margin, 20, style="DF")
    pdf.set_xy(pdf.l_margin + 4, y0 + 3)
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(*NAVY)
    pdf.cell(30, 14, "6.5")
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(*GREY)
    pdf.set_xy(pdf.l_margin + 34, y0 + 4)
    pdf.cell(0, 6, "Overall condition score (out of 10)", new_x="LMARGIN", new_y="NEXT")
    pdf.set_xy(pdf.l_margin + 34, y0 + 10)
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*AMBER)
    pdf.cell(0, 7, "Recommendation:  Negotiate / Repair First")
    pdf.set_y(y0 + 24)

    h2(pdf, "Inspection overview")
    para(pdf, "A sound, well-optioned example that presents well and shows no evidence of prior collision repair. "
              "Two items should factor into your offer: rear tires near their wear limit and a minor valve-cover oil "
              "seepage. Nothing observed indicates an immediate safety hazard. Addressing the noted items and "
              "negotiating accordingly is reasonable.")

    h2(pdf, "Vehicle details")
    kv(pdf, [
        ("Year/Make/Model", "2019 Chevrolet Corvette"), ("Trim", "Stingray (demo)"),
        ("VIN", "1G1YY..00000 (fictional)"), ("Odometer", "28,450 mi (demo)"),
        ("Location type", "Private seller"), ("Inspection date", "Demonstration"),
    ])

    h2(pdf, "Immediate safety concerns")
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(*GREEN)
    pdf.multi_cell(0, 5.6, "None observed at the time of inspection.")

    h2(pdf, "Major findings")
    finding(pdf, "Priority", RED, "Rear tires near wear limit",
            "Both rear tires measured ~3/32\". Serviceable now but replacement should be budgeted soon; date codes indicate ~5-year-old tires.",
            "$500-$900")

    h2(pdf, "Moderate findings")
    finding(pdf, "Moderate", AMBER, "Valve-cover oil seepage (driver side)",
            "Light seepage observed; no active dripping or low-oil condition. Monitor; reseal if it progresses.", "$250-$600")
    finding(pdf, "Moderate", AMBER, "Front bumper stone chips & light curb rash on one wheel",
            "Cosmetic only; noted for negotiation. No structural concern.", "$150-$400")

    h2(pdf, "Maintenance observations")
    finding(pdf, "Note", BLUESOFT, "Brake fluid slightly dark", "Due for a flush based on appearance; inexpensive routine service.", "$100-$180")
    finding(pdf, "Note", BLUESOFT, "Cabin air filter dirty", "Minor; owner-serviceable item.", "$20-$60")

    h2(pdf, "Tire & brake measurements")
    kv(pdf, [
        ("Front tires", "6/32\" & 6/32\""), ("Rear tires", "3/32\" & 3/32\""),
        ("Front brake pad", "~7 mm"), ("Rear brake pad", "~6 mm"),
        ("Rotors", "Within limits"), ("Tire age (approx.)", "~5 years"),
    ])

    h2(pdf, "Visible leaks & fluids")
    para(pdf, "Minor valve-cover seepage as noted above. Coolant, transmission and power-steering: no visible leaks; "
              "fluid levels and condition acceptable.")

    h2(pdf, "Body & paint observations")
    para(pdf, "Paint-depth spot checks were consistent across panels; no evidence of prior collision repair or repaint "
              "observed. Panel gaps uniform. Glass free of cracks; minor rock chip on windshield outside the driver's line of sight.")

    h2(pdf, "Road-test observations")
    para(pdf, "Cold start normal. Idle steady. Transmission shifted cleanly through the range under light and moderate "
              "load. No abnormal noises, vibration, or pulling. Brakes firm and straight. Climate control functioned in all "
              "modes. (Road test performed with seller permission in this demonstration.)")

    h2(pdf, "Underbody review & limitations")
    para(pdf, "Underbody inspected to the extent safely and physically possible at the location. A full lift inspection was "
              "not performed. Visible undercarriage areas showed no structural damage, active leaks, or crash residue. A "
              "partner-facility lift can be arranged for a deeper underbody inspection at additional charge.")

    h2(pdf, "Photographic findings")
    para(pdf, "Your real report includes clear photographs of every meaningful finding (rear tire tread, valve-cover "
              "seepage, bumper chips, wheel curb rash, odometer, and the VIN plate).")

    h2(pdf, "Estimated repair-cost ranges & negotiation considerations")
    para(pdf, "Priority + moderate items total roughly $900-$1,900 in the near term (rear tires being the main driver). "
              "These are reasonable, documented points to raise with the seller. None are deal-breakers on their own for a "
              "vehicle that otherwise presents well.")

    h2(pdf, "Inspection limitations")
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(90, 98, 116)
    pdf.multi_cell(0, 4.8, "This inspection is a professional opinion of the vehicle's observable condition at the time of "
                   "inspection. It is visual and non-invasive unless expressly stated; components are not disassembled. Hidden, "
                   "intermittent, or future failures may not be detectable. Seller access and location can limit what is possible. "
                   "A pre-purchase inspection is not a warranty or guarantee, and the buyer retains the final purchasing decision.")

    h2(pdf, "Inspector")
    para(pdf, "Faheb Brown - Founder & Lead Technician, AutoClarity. 11+ years of hands-on automotive experience. "
              "Every Las Vegas inspection currently performed personally by the founder.")

    pdf.set_title("AutoClarity Sample Pre-Purchase Inspection Report (Demonstration)")
    pdf.set_author("AutoClarity")
    pdf.output(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()

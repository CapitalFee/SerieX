package books

import "strings"

// AddressText builds a multi-line address block the way SerieX Books does on
// its forms: the name, the address lines, "City, ST ZIP" and the country
// (empty parts are left out). A line that repeats the line above it (an
// address whose first line is the name) is not repeated.
func AddressText(name string, a Address) string {
	stateZip := strings.TrimSpace(strings.TrimSpace(a.State) + " " + strings.TrimSpace(a.Zip))
	var cityLine string
	switch city := strings.TrimSpace(a.City); {
	case city != "" && stateZip != "":
		cityLine = city + ", " + stateZip
	case city != "":
		cityLine = city
	default:
		cityLine = stateZip
	}
	var lines []string
	for _, s := range []string{name, a.Line1, a.Line2, a.Line3, cityLine, a.Country} {
		s = strings.TrimSpace(s)
		if s == "" || (len(lines) > 0 && strings.EqualFold(lines[len(lines)-1], s)) {
			continue
		}
		lines = append(lines, s)
	}
	return strings.Join(lines, "\n")
}

// CheckAddress is the address SerieX Books prints on a check written to a name
// (Write Checks fills it the same way): "Print on check as" (else the company
// name, else the name) followed by the bill address.
func CheckAddress(n Name) string {
	top := strings.TrimSpace(n.PrintOnCheckAs)
	if top == "" {
		top = strings.TrimSpace(n.CompanyName)
	}
	if top == "" {
		top = n.Name
	}
	return AddressText(top, n.BillAddress)
}

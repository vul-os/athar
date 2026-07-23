package ingest

import "strings"

// This is a deliberately small user-agent classifier rather than a dependency on
// a regex database.
//
// Athar reports browser / OS / device as a coarse breakdown — the question a
// dashboard answers is "is my site broken on Safari?", not "which of 40 Chromium
// forks is this". A hundred lines of ordered prefix matching answers that
// accurately, adds no supply-chain surface to a script that runs on every
// beacon, and never needs a data-file update to keep working.
//
// Order matters throughout: nearly every browser's UA string claims to be
// several other browsers, so the most specific token has to be tested first.

// browserRule maps a UA token to a display name. Evaluated in order.
type browserRule struct{ token, name string }

var browserRules = []browserRule{
	// Chromium forks all contain "Chrome", so they must precede it.
	{"YaBrowser", "Yandex"},
	{"Edg/", "Edge"},        // modern Edge; "Edge/" was the legacy EdgeHTML one
	{"EdgA/", "Edge"},       // Android
	{"EdgiOS/", "Edge"},     // iOS
	{"OPR/", "Opera"},       // Chromium-era Opera
	{"Opera", "Opera"},      // Presto-era
	{"Vivaldi", "Vivaldi"},
	{"Brave", "Brave"},
	{"SamsungBrowser", "Samsung Internet"},
	{"DuckDuckGo", "DuckDuckGo"},

	// Firefox forks before Firefox.
	{"Waterfox", "Waterfox"},
	{"LibreWolf", "LibreWolf"},
	{"FxiOS/", "Firefox"}, // Firefox on iOS is a WebKit shell
	{"Firefox", "Firefox"},

	// Chrome and Safari last: everything above also matches one of them.
	{"CriOS/", "Chrome"}, // Chrome on iOS
	{"Chrome", "Chrome"},
	{"Chromium", "Chromium"},
	{"Safari", "Safari"},

	{"MSIE", "Internet Explorer"},
	{"Trident", "Internet Explorer"},
}

// Bot tokens. Athar drops these beacons rather than recording them as visitors:
// a crawler is not a person, and letting one into the numbers makes every
// report wrong in the same quiet direction.
var botTokens = []string{
	"bot", "crawler", "spider", "crawl", "slurp", "curl", "wget",
	"headlesschrome", "phantomjs", "lighthouse", "pingdom", "uptime",
	"monitor", "python-requests", "go-http-client", "axios", "postman",
	"facebookexternalhit", "preview", "scanner", "archiver", "feedfetcher",
	"validator", "checker",
}

type osRule struct{ token, name string }

// Ordered: iOS-family tokens before "Mac OS X" (iPads report both), Android
// before Linux (Android is Linux), Chrome OS before Linux.
var osRules = []osRule{
	{"Windows NT 10", "Windows"},
	{"Windows NT", "Windows"},
	{"Windows Phone", "Windows Phone"},
	{"iPhone", "iOS"},
	{"iPad", "iPadOS"},
	{"iPod", "iOS"},
	{"Android", "Android"},
	{"CrOS", "Chrome OS"},
	{"Mac OS X", "macOS"},
	{"Macintosh", "macOS"},
	{"Ubuntu", "Linux"},
	{"Fedora", "Linux"},
	{"Linux", "Linux"},
	{"FreeBSD", "FreeBSD"},
	{"OpenBSD", "OpenBSD"},
}

// Device is a coarse form factor.
const (
	DeviceDesktop = "desktop"
	DeviceMobile  = "mobile"
	DeviceTablet  = "tablet"
	DeviceUnknown = ""
)

// UserAgent is the classification of one UA string.
type UserAgent struct {
	Browser string
	OS      string
	Device  string
	IsBot   bool
}

// ParseUserAgent classifies a UA string. Unrecognised values yield empty fields
// rather than a guess — an honest blank is more useful in a breakdown than a
// wrong label, and the reporting queries already skip empty dimensions.
func ParseUserAgent(ua string) UserAgent {
	var out UserAgent
	if ua == "" {
		return out
	}
	lower := strings.ToLower(ua)

	for _, tok := range botTokens {
		if strings.Contains(lower, tok) {
			out.IsBot = true
			return out
		}
	}

	for _, r := range browserRules {
		if strings.Contains(ua, r.token) {
			out.Browser = r.name
			break
		}
	}
	for _, r := range osRules {
		if strings.Contains(ua, r.token) {
			out.OS = r.name
			break
		}
	}
	out.Device = classifyDevice(ua, lower, out.OS)
	return out
}

// classifyDevice picks a form factor.
//
// The tablet case is the fiddly one: an iPad since iPadOS 13 reports a desktop
// Safari UA indistinguishable from a Mac, so tablet detection leans on the
// screen dimensions the tracker reports (see DeviceFromScreen) and this function
// only catches the cases the UA does state outright.
func classifyDevice(ua, lower, os string) string {
	switch os {
	case "iPadOS":
		return DeviceTablet
	case "iOS", "Android":
		// Android tablets omit "Mobile" from the token; phones include it.
		if os == "Android" && !strings.Contains(ua, "Mobile") {
			return DeviceTablet
		}
		return DeviceMobile
	case "Windows Phone":
		return DeviceMobile
	}
	if strings.Contains(lower, "tablet") || strings.Contains(lower, "kindle") ||
		strings.Contains(lower, "playbook") || strings.Contains(lower, "silk") {
		return DeviceTablet
	}
	if strings.Contains(lower, "mobile") {
		return DeviceMobile
	}
	if os != "" {
		return DeviceDesktop
	}
	return DeviceUnknown
}

// DeviceFromScreen refines the form factor using the viewport the tracker
// reported. It only ever *narrows* an unknown or desktop classification, and
// only on the basis of width — a small window on a laptop is indistinguishable
// from a tablet, and calling it a tablet would be a guess; calling a 390px-wide
// screen a desktop is simply wrong.
func DeviceFromScreen(device string, width int) string {
	if width <= 0 {
		return device
	}
	if device == DeviceMobile || device == DeviceTablet {
		return device // the UA already said so, and it knows better than width
	}
	switch {
	case width < 576:
		return DeviceMobile
	case width < 992:
		return DeviceTablet
	default:
		return DeviceDesktop
	}
}

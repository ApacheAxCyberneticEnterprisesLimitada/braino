import { useId } from "react";
import { cn } from "~/lib/cn";

const VIEWBOX_WIDTH = 588;
const VIEWBOX_HEIGHT = 180;
const MARK_VIEWBOX_WIDTH = 180;
const ASPECT = VIEWBOX_WIDTH / VIEWBOX_HEIGHT;

interface DocoMarkProps {
  height: number;
  className?: string;
  active?: boolean;
  ariaLabel?: string;
  /** Neumorphic: solid purple standing out of the page like a key (`.doco-mark-raised`). */
  raised?: boolean;
  variant?: "logo" | "mark";
}

export function DocoMark({
  height,
  className,
  active = false,
  ariaLabel = "Doco",
  raised = false,
  variant = "logo",
}: DocoMarkProps) {
  const reactId = useId();
  const maskId = `${reactId}-mask`;
  const clipId = `${reactId}-orb-clip`;
  const showWordmark = variant === "logo";
  const viewBoxWidth = showWordmark ? VIEWBOX_WIDTH : MARK_VIEWBOX_WIDTH;
  const width = height * (showWordmark ? ASPECT : MARK_VIEWBOX_WIDTH / VIEWBOX_HEIGHT);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxWidth} ${VIEWBOX_HEIGHT}`}
      width={width}
      height={height}
      focusable="false"
      className={cn(
        "doco-mark block",
        active && "doco-mark-active",
        raised && "doco-mark-raised",
        className,
      )}
      role="img"
      aria-label={ariaLabel}
    >
      <title>{ariaLabel}</title>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <rect x="0" y="0" width="200" height="200" fill="white" />
          <polygon
            className="doco-mark-spark doco-mark-spark-lg"
            fill="black"
            points="86,18 89.96,32.04 104,36 89.96,39.96 86,54 82.04,39.96 68,36 82.04,32.04"
          />
          <polygon
            className="doco-mark-spark doco-mark-spark-md"
            fill="black"
            points="120,43 122.42,51.58 131,54 122.42,56.42 120,65 117.58,56.42 109,54 117.58,51.58"
          />
          <polygon
            className="doco-mark-spark doco-mark-spark-sm"
            fill="black"
            points="68,70 69.76,76.24 76,78 69.76,79.76 68,86 66.24,79.76 60,78 66.24,76.24"
          />
        </mask>
        {/* Orb circle in absolute viewBox coordinates — i.e. cx=100*0.8259+8,
            cy=82*0.8259+0.588, r=70*0.8259 — so the clipped mist group
            below can reference it without inheriting the glyph's inner
            translate+scale. */}
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <circle cx="90.59" cy="68.31" r="57.81" />
        </clipPath>
      </defs>
      <g className="doco-mark-glyph-motion">
        <g fill="#9945A1" transform="translate(8 0.588) scale(0.8259)">
          <path d="M 56 182 L 144 182 L 130 158 L 70 158 Z" />
          <circle cx="100" cy="82" r="70" mask={`url(#${maskId})`} />
        </g>
      </g>
      {showWordmark ? (
        // "Doco" in Chomsky (fonts/chomsky.ts), the blackletter after the New
        // York Times nameplate, as outlines: its D stands where Ubuntu's did,
        // from 10 down to the baseline at 150, so the orb keeps its scale.
        <path
          fill="#9945A1"
          d="M207.6 124.6L209.3 128.9C225.9 124.7 241.5 113.7 241.5 91.7L241.5 73.5L241.5 59.6C241.5 49.8 244.7 44.7 250.1 39.9L255.6 39.9C249.9 46 247.8 54.7 247.8 66.1L247.8 98.1C247.8 111.4 240.1 118 233.1 124.7C216 129.6 203.4 141.5 196 155.6L201.1 155.6C210.7 146.8 223.7 141.8 236.8 141.8C248.1 141.8 258.7 145.3 267.6 151.7L312.1 127.2C318.7 113.8 323.9 96 323.9 77.4C323.9 43.3 310.6 18.1 273.3 18.1L224.6 18.1C217.6 18.1 212.6 16 211.5 10.1L207.7 10C204.4 22.3 204.4 39.9 218.8 39.9L243.6 39.9L229.5 49C223.2 53.2 218.5 57.2 218.5 67.8C218.5 69.2 218.5 70.6 218.5 72C207.3 73.9 197.8 78.1 197.8 91.9C197.8 95.5 198.8 99.2 200.5 102.4L204 102.4C203.3 96.2 206.9 92.1 214.2 92.1C215.6 92.1 217 92.1 218.5 92.1C218.5 92.2 218.5 92.4 218.5 92.6C218.5 107.4 217.5 119 207.6 124.6M267.2 124.3C267.2 116.6 267.2 108.8 267.2 101L299.7 84.6C299.6 104 295.6 120.3 289.7 135.2C283 130.1 275.3 126.4 267.2 124.3M267.2 39.9C271.3 39.9 275.4 40.2 279.2 41.5C288.1 44.6 293.6 51.7 296.6 61.1L267.2 75.9C267.2 63.9 267.2 51.9 267.2 39.9M262.1 123.2C258.5 122.6 254.7 122.2 251 122.2C247.9 122.2 244.9 122.4 242 122.8C247.8 116.7 252.8 109.5 252.8 98.1L252.8 66.1C252.8 54.1 254.9 45.9 262.1 40.8C262.1 68.2 262.1 95.7 262.1 123.2M267.2 81.6L298 66.1C298.8 70.1 299.4 74.4 299.6 78.9L267.2 95.3C267.2 90.7 267.2 86.2 267.2 81.6M362.4 122.7L362.4 71.4L382.9 85.1L382.9 136.4M333.4 137.9L340.8 131.9L365.8 150L405.1 126.1L405.1 77.4L379.5 57.8L339.3 80.8C339.3 96.1 339.3 111.4 339.3 126.7L330.2 134.1M444.2 119C449.5 128.7 459.1 131.2 464.3 131.3L474.6 123.9L476.9 127L450.7 150L448.2 150L421.3 131.7L421.3 78.4L458.1 57.9L476.9 73L460 85.8L444.2 72.6M511.9 122.7L511.9 71.4L532.4 85.1L532.4 136.4M482.9 137.9L490.3 131.9L515.4 150L554.7 126.1L554.7 77.4L529 57.8L488.9 80.8C488.9 96.1 488.9 111.4 488.9 126.7L479.7 134.1"
        />
      ) : null}
      {/* "Crystal-ball mist" — only visible when the mark is .doco-mark-active.
          Three soft tinted blobs rotate at different speeds and directions
          inside the orb. Clipped to the orb circle. Sits in front of the
          glyph so the swirl reads cleanly over the purple fill. */}
      <g className="doco-mark-mist" clipPath={`url(#${clipId})`} aria-hidden>
        <g className="doco-mark-mist-blob doco-mark-mist-1">
          <ellipse
            cx="73.27"
            cy="53.86"
            rx="31.80"
            ry="20.23"
            fill="#e3afff"
            opacity="0.55"
            filter="blur(3px)"
          />
        </g>
        <g className="doco-mark-mist-blob doco-mark-mist-2">
          <ellipse
            cx="102.15"
            cy="78.71"
            rx="34.69"
            ry="17.34"
            fill="#ffd1f5"
            opacity="0.45"
            filter="blur(3px)"
          />
        </g>
        <g className="doco-mark-mist-blob doco-mark-mist-3">
          <ellipse
            cx="90.59"
            cy="72.93"
            rx="26.01"
            ry="14.45"
            fill="#ffffff"
            opacity="0.55"
            filter="blur(3px)"
          />
        </g>
      </g>
    </svg>
  );
}

"""NCTracks Eligibility Verifier — Entry point."""

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("nctracks_verifier.log", mode="a"),
    ],
)

from ui import NCTracksVerifierApp


def main():
    app = NCTracksVerifierApp()
    app.run()


if __name__ == "__main__":
    main()

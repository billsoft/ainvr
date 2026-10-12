#pragma once
namespace ainvr_license {
// Inject only AINVR's public issuer material when building a release.
// An unprovisioned build trusts no issuer; private keys never belong on the board.
#ifndef AINVR_ISSUER_KEY_ID
#define AINVR_ISSUER_KEY_ID ""
#endif
#ifndef AINVR_ISSUER_PUBLIC_KEY_HEX
#define AINVR_ISSUER_PUBLIC_KEY_HEX ""
#endif
inline constexpr char kIssuerKeyId[] = AINVR_ISSUER_KEY_ID;
inline constexpr char kIssuerPublicKeyHex[] = AINVR_ISSUER_PUBLIC_KEY_HEX;
}

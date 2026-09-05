#!/bin/sh
set -eu

BASE_PATH=${BASE_PATH:-/}
case "$BASE_PATH" in
    */) ;;
    *) BASE_PATH="$BASE_PATH/" ;;
esac
case "$BASE_PATH" in
    *[!a-zA-Z0-9._~/-]*|*//*|*/./*|*/../*|*__HEADSCALE_UI_BASE__*)
        echo "Invalid BASE_PATH: use an absolute path with unreserved URL characters and no empty or dot segments." >&2
        exit 1
        ;;
    /*) ;;
    *)
        echo "Invalid BASE_PATH: the path must start with /." >&2
        exit 1
        ;;
esac

# Always render from the original build so restarting never compounds substitutions.
destination="/usr/share/headscale-ui${BASE_PATH}"
mkdir -p "$destination"
cp -R /opt/headscale-ui/dist/. "$destination"
find "$destination" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) \
    -exec sed -i "s|/__HEADSCALE_UI_BASE__/|${BASE_PATH}|g" {} +
if grep -rl '__HEADSCALE_UI_BASE__' "$destination"; then
    echo "Failed to configure BASE_PATH: unresolved build placeholder." >&2
    exit 1
fi

BASE_REDIRECT=
BASE_FALLBACK=
if [ "$BASE_PATH" != / ]; then
    BASE_REDIRECT="location = ${BASE_PATH%/} { return 308 ${BASE_PATH}\$is_args\$args; }"
    BASE_FALLBACK='location / { return 404; }'
fi
export BASE_PATH BASE_REDIRECT BASE_FALLBACK
envsubst '${BASE_PATH} ${BASE_REDIRECT} ${BASE_FALLBACK}' \
    < /opt/headscale-ui/nginx.conf.template > /etc/nginx/conf.d/default.conf
nginx -t

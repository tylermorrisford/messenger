FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:alpine

RUN apk add --no-cache bash curl postgresql16-client

COPY backup.sh /usr/local/bin/backup.sh

# gcloud writes config under $HOME, and nobody can't write to /
ENV HOME=/tmp CLOUDSDK_CONFIG=/tmp/gcloud
USER nobody

ENTRYPOINT ["/usr/local/bin/backup.sh"]

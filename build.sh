docker compose build
docker service update --force pdfannotate_frontend
docker service update --force pdfannotate_backend
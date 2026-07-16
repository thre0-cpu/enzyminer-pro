# Third-Party Notices

EnzyMiner Pro itself is distributed under the Apache License 2.0. That license applies to this repository's original application code and documentation; it does **not** automatically relicense third-party software, models, model weights, databases, web services, or datasets used by or connected to the application.

The workflow can interoperate with or reference the following third-party projects and resources:

- HMMER and the EMBL-EBI HMMER web services
- NCBI BLAST+ and NCBI protein resources
- UniProt and UniProt reference databases
- CD-HIT
- MMseqs2
- MAFFT
- Cytoscape and Cytoscape.js
- CLEAN and its pretrained data
- CataPro and its pretrained data
- PLM_Sol and its pretrained data
- ProtT5 and MolT5 model families and weights
- React, React DOM, Vite, Tailwind CSS, Express, D3 modules, Lucide, and other packages listed in `package-lock.json`

Each third-party component remains subject to its own upstream license, terms of use, citation requirements, database policies, and model-weight restrictions. Before redistribution or production deployment, review the license and usage terms shipped by or published for the exact version of every third-party component and data resource you install.

The bundled V1.1 example case contains synthetic demonstration sequences and mock prediction values created for software testing. It is not a biological benchmark and must not be interpreted as experimental evidence.


async function renderPreviewPage(pageNumber: number, pageWidth: number, pageHeight: number, blocks:Block[]) {

    const blocksSvg = blocks.filter(block=>block.type !== 'PAGE' && block.type !== 'LINE').map(block=>`
            <svg class="group ${block.type}" id="mouse" onclick="activate_group()">
               <rect class="segment" x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" />
            </svg>`).join('\n');

    return `<!DOCTYPE html>
<head>

    <style>

     #annotatedPage {
         position:relative; display:inline-block;
     }

     #annotatedPage svg {
        position:absolute; top:0; left:0;
     }

     .group.WORD > rect.segment {
         fill-opacity: 10%;
stroke-width:3;
         stroke:green;
     }

     .group.LINE > rect.segment {
         stroke:blue;
         stroke-width:6;
     }

     .group:hover > rect.segment {
stroke:red !important;
     }

     .group.active > rect.segment {
         stroke-width:3;
         stroke:purple;
     }

    </style>

    <script>
     function activate_group() {
         const group_elem = event.currentTarget;

         console.info('activate group', group_elem.id);

         const current_active_group_elem = document.querySelector('#annotatedPage svg .group.active');
         if(current_active_group_elem) {
             console.info('deactivating group', current_active_group_elem.id);
             current_active_group_elem.classList.remove('active');
         }
         
         group_elem.classList.add('active');
     }
    </script>

</head>

<body>

    <div>
    <h1>PDM Textract preview page ${pageNumber}</h1>
    <a href="./page-${String(pageNumber-1).padStart(5, '0')}.html">PREV</a> / 
    <a href="./page-${String(pageNumber+1).padStart(5, '0')}.html">NEXT</a>

    </div>
    <div id="annotatedPage">
        
         <img src="../pdm/page-${String(pageNumber).padStart(5, '0')}.jpg" width="${pageWidth}" height="${pageHeight}">
         <svg width="${pageWidth}" height="${pageHeight}">
${blocksSvg}
        </svg>
    </div>
    <div>
       <a href="./page-${String(pageNumber-1).padStart(5, '0')}.html">PREV</a> / 
       <a href="./page-${String(pageNumber+1).padStart(5, '0')}.html">NEXT</a>
    </div>
</body>`;
}


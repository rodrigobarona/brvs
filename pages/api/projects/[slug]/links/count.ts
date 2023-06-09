import { withProjectAuth } from "@/lib/auth";
import { getLinksCount } from "@/lib/api/links";

export default withProjectAuth(async (req, res, project) => {
  // GET /api/projects/[slug]/domains/[domain]/links/count – count the number of links for a project
  if (req.method === "GET") {
    const count = await getLinksCount({
      req,
      projectId: project.id,
    });
    return res.status(200).json(count);
  } else {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
});
